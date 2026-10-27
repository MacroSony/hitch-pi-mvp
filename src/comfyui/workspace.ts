import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, normalize } from "node:path";

import type { MediaStore } from "../media/media-store.js";
import type { RuntimeArtifact } from "../runtime/runtime.js";

const INVALID = "Comfy workspace result is unavailable.";
const MAX_BYTES = 10 * 1024 * 1024;
const SUFFIX = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
} as const;

function reject(): never {
  throw new Error(INVALID);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameInode(a, b) &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function privateFile(stat: BigIntStats, uid: bigint, size: number): void {
  if (
    !stat.isFile() ||
    stat.uid !== uid ||
    stat.nlink !== 1n ||
    (stat.mode & 0o7077n) !== 0n ||
    stat.size !== BigInt(size)
  )
    reject();
}

/** Bounded descriptor read, including EOF and pre/post metadata checks. */
function verifiedBytes(
  fd: number,
  uid: bigint,
  artifact: RuntimeArtifact,
  immutable = false,
): { bytes: Buffer; stat: BigIntStats } {
  const before = fstatSync(fd, { bigint: true });
  privateFile(before, uid, artifact.bytes);
  if (immutable && (before.mode & 0o222n) !== 0n) reject();
  const bytes = Buffer.alloc(artifact.bytes);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) reject();
    offset += count;
  }
  if (
    readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
    !sameSnapshot(before, fstatSync(fd, { bigint: true })) ||
    digest(bytes) !== artifact.sha256
  )
    reject();
  return { bytes, stat: before };
}

// This is a copy helper, not a media decoder. The trusted caller supplies the
// completed, owner-scoped result already validated by ComfyService/MediaStore
// (including inspectGeneratedVideo for MP4). Reject obvious MIME mismatches too.
function checkSignature(bytes: Buffer, mime: string): void {
  const matches =
    mime === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      : mime === "image/jpeg"
        ? bytes.length >= 4 &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8 &&
          bytes.at(-2) === 0xff &&
          bytes.at(-1) === 0xd9
        : mime === "image/webp"
          ? bytes.length >= 30 &&
            bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP" &&
            bytes.readUInt32LE(4) + 8 === bytes.length
          : bytes.length >= 20 &&
            bytes.toString("ascii", 4, 8) === "ftyp" &&
            bytes.readUInt32BE(0) >= 20 &&
            bytes.readUInt32BE(0) <= bytes.length;
  if (!matches) reject();
}

/**
 * Copy an already validated immutable own Comfy result into a trusted configured
 * workspace. Linux /proc must be available. No model-controlled destination,
 * host paths in results/errors, generation, publication, or network activity.
 *
 * Workspace contents remain untrusted/mutable after return. Callers must still
 * use the normal immutable publication snapshot before sending any live file.
 */
export function materializeComfyWorkspaceResult({
  userId,
  workspace,
  artifact: input,
  media,
}: {
  readonly userId: string;
  readonly workspace: string;
  readonly artifact: RuntimeArtifact;
  readonly media: MediaStore;
}): { path: string; relativePath: string } {
  const descriptors: number[] = [];
  try {
    const artifact = { ...input };
    const uidNumber = process.getuid?.();
    const match =
      /^artifact_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(
        artifact.id,
      );
    if (
      process.platform !== "linux" ||
      uidNumber === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(userId) ||
      artifact.userId !== userId ||
      !match ||
      artifact.storageKey !== `${userId}/${match[1]}.blob` ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > MAX_BYTES ||
      !Object.hasOwn(SUFFIX, artifact.mimeType) ||
      artifact.mediaKind !==
        (artifact.mimeType === "video/mp4" ? "file" : "image") ||
      !isAbsolute(workspace) ||
      normalize(workspace) !== workspace ||
      workspace === "/" ||
      workspace.endsWith("/") ||
      workspace.includes("\0")
    )
      reject();
    const uid = BigInt(uidNumber);
    const track = (fd: number): number => {
      descriptors.push(fd);
      return fd;
    };
    const dirFlags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    // Walk every component from an open / descriptor: O_NOFOLLOW on only the
    // final workspace component would still allow ancestor symlink escapes.
    let parent = track(openSync("/", dirFlags));
    const chain: Array<{ parent: number; name: string; fd: number }> = [];
    for (const name of workspace.slice(1).split("/")) {
      const fd = track(openSync(`/proc/self/fd/${parent}/${name}`, dirFlags));
      chain.push({ parent, name, fd });
      parent = fd;
    }
    const dirFd = parent;
    const anchored = `/proc/self/fd/${dirFd}`;
    const checkDirectory = (): void => {
      for (const entry of chain) {
        const current = lstatSync(
          `/proc/self/fd/${entry.parent}/${entry.name}`,
          {
            bigint: true,
          },
        );
        if (
          !current.isDirectory() ||
          !sameInode(current, fstatSync(entry.fd, { bigint: true }))
        )
          reject();
      }
      const stat = fstatSync(dirFd, { bigint: true });
      if (
        stat.uid !== uid ||
        (stat.mode & 0o7077n) !== 0n ||
        readlinkSync(anchored) !== workspace
      )
        reject();
    };
    checkDirectory();
    const source = track(
      openSync(
        media.verifiedObjectPath(artifact),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ),
    );
    // Reverify the actual opened descriptor, not the pathname checked by media.
    const { bytes } = verifiedBytes(source, uid, artifact, true);
    checkSignature(bytes, artifact.mimeType);
    checkDirectory();
    const suffix = SUFFIX[artifact.mimeType as keyof typeof SUFFIX];
    const relativePath = `comfy-${match[1]}.${suffix}`;
    const targetPath = `${anchored}/${relativePath}`;
    let target: number;
    let created = false;
    try {
      target = track(
        openSync(
          targetPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        ),
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      target = track(
        openSync(
          targetPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ),
      );
    }
    if (created) {
      let offset = 0;
      while (offset < bytes.length) {
        privateFile(fstatSync(target, { bigint: true }), uid, offset);
        const count = writeSync(
          target,
          bytes,
          offset,
          Math.min(64 * 1024, bytes.length - offset),
          offset,
        );
        if (count === 0) reject();
        offset += count;
      }
    }
    const verified = verifiedBytes(target, uid, artifact);
    fsyncSync(target);
    fsyncSync(dirFd);
    const final = fstatSync(target, { bigint: true });
    privateFile(final, uid, artifact.bytes);
    if (
      !sameSnapshot(verified.stat, final) ||
      !sameSnapshot(final, lstatSync(targetPath, { bigint: true }))
    )
      reject();
    checkDirectory();
    return { path: `/workspace/${relativePath}`, relativePath };
  } catch {
    // Deliberately omit the original error/cause: fs errors contain host paths.
    return reject();
  } finally {
    for (const fd of descriptors.reverse()) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort own descriptor cleanup only. Never unlink a raced name:
        // a failed/partial exclusive create is retained and fails closed later.
      }
    }
  }
}
