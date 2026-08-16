import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { AppError } from "../app/errors.js";
import type { RuntimeArtifact } from "../runtime/runtime.js";

export const MAX_INPUT_ARTIFACTS = 8;
export const MAX_INPUT_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_INPUT_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_OUTBOUND_ARTIFACTS = 8;
export const MAX_OUTBOUND_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_USER_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_IMAGE_SIDE = 16_384;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_GIF_FRAMES = 100;
const COPY_BUFFER_BYTES = 64 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const OBJECT_PATTERN = /^([0-9a-f-]{36})\.blob$/u;

export interface InboundMediaOptions {
  readonly advertisedBytes?: number;
  readonly advertisedMime?: string;
  readonly displayName?: string;
  readonly expectImage?: boolean;
}

interface ImageInfo {
  readonly mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly frames: number;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const metadata = lstatSync(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== BigInt(uid)) ||
    (metadata.mode & 0o077n) !== 0n ||
    realpathSync(path) !== path
  ) {
    throw new Error("media directory is unsafe");
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function boundedDisplayName(value?: string): string {
  const candidate = (value ?? "attachment").normalize("NFC");
  if (
    candidate.length === 0 ||
    candidate === "." ||
    candidate === ".." ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    CONTROL_PATTERN.test(candidate) ||
    Buffer.byteLength(candidate, "utf8") > 128
  ) {
    return "attachment";
  }
  return candidate;
}

function boundedMime(value?: string): string {
  if (
    value === undefined ||
    value.length === 0 ||
    Buffer.byteLength(value, "ascii") > 127 ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value)
  ) {
    return "application/octet-stream";
  }
  return value.toLowerCase();
}

function dimensions(width: number, height: number): void {
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_SIDE ||
    height > MAX_IMAGE_SIDE ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new AppError("media-invalid", "image dimensions exceed MVP limits");
  }
}

function animatedPixels(width: number, height: number, frames: number): void {
  if (width * height * frames > MAX_IMAGE_PIXELS)
    throw new AppError(
      "media-invalid",
      "animated image decoded pixels exceed MVP limits",
    );
}

function png(buffer: Buffer): ImageInfo | null {
  if (
    buffer.length < 33 ||
    !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  dimensions(width, height);
  let offset = 8;
  let frames = 1;
  let ended = false;
  let hasImageData = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length)
      throw new AppError("media-invalid", "PNG chunk is invalid");
    if (offset === 8 && (type !== "IHDR" || length !== 13))
      throw new AppError("media-invalid", "PNG structure is invalid");
    if (type === "acTL") {
      if (length !== 8)
        throw new AppError(
          "media-invalid",
          "PNG animation metadata is invalid",
        );
      frames = buffer.readUInt32BE(offset + 8);
      if (frames < 1 || frames > MAX_GIF_FRAMES)
        throw new AppError(
          "media-invalid",
          "PNG frame count exceeds MVP limits",
        );
    }
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== buffer.length)
        throw new AppError("media-invalid", "PNG ending is invalid");
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended || !hasImageData)
    throw new AppError("media-invalid", "PNG is incomplete");
  animatedPixels(width, height, frames);
  return { mimeType: "image/png", width, height, frames };
}

function jpeg(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    return null;
  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === undefined || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length)
      throw new AppError("media-invalid", "JPEG structure is invalid");
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (length < 7)
        throw new AppError("media-invalid", "JPEG dimensions are invalid");
      height = buffer.readUInt16BE(offset + 3);
      width = buffer.readUInt16BE(offset + 5);
    }
    offset += length;
  }
  if (
    width === 0 ||
    height === 0 ||
    buffer.at(-2) !== 0xff ||
    buffer.at(-1) !== 0xd9
  )
    throw new AppError("media-invalid", "JPEG is incomplete");
  dimensions(width, height);
  return { mimeType: "image/jpeg", width, height, frames: 1 };
}

function gif(buffer: Buffer): ImageInfo | null {
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  if (buffer.length < 14 || buffer.at(-1) !== 0x3b)
    throw new AppError("media-invalid", "GIF is incomplete");
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  dimensions(width, height);
  let offset = 13;
  if ((buffer[10]! & 0x80) !== 0) offset += 3 * 2 ** ((buffer[10]! & 0x07) + 1);
  let frames = 0;
  const skipBlocks = (): void => {
    for (;;) {
      const size = buffer[offset];
      if (size === undefined)
        throw new AppError("media-invalid", "GIF blocks are invalid");
      offset += 1;
      if (size === 0) return;
      offset += size;
      if (offset > buffer.length)
        throw new AppError("media-invalid", "GIF blocks are invalid");
    }
  };
  while (offset < buffer.length - 1) {
    const marker = buffer[offset++];
    if (marker === 0x2c) {
      frames += 1;
      if (frames > MAX_GIF_FRAMES)
        throw new AppError(
          "media-invalid",
          "GIF frame count exceeds MVP limits",
        );
      if (offset + 9 > buffer.length)
        throw new AppError("media-invalid", "GIF frame is invalid");
      dimensions(
        buffer.readUInt16LE(offset + 4),
        buffer.readUInt16LE(offset + 6),
      );
      const packed = buffer[offset + 8]!;
      offset += 9;
      if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
      if (offset >= buffer.length)
        throw new AppError("media-invalid", "GIF frame is invalid");
      offset += 1;
      skipBlocks();
    } else if (marker === 0x21) {
      if (offset >= buffer.length)
        throw new AppError("media-invalid", "GIF extension is invalid");
      offset += 1;
      skipBlocks();
    } else {
      throw new AppError("media-invalid", "GIF structure is invalid");
    }
  }
  if (frames === 0)
    throw new AppError("media-invalid", "GIF contains no image frame");
  animatedPixels(width, height, frames);
  return { mimeType: "image/gif", width, height, frames };
}

function webp(buffer: Buffer): ImageInfo | null {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  )
    return null;
  if (buffer.readUInt32LE(4) + 8 !== buffer.length)
    throw new AppError("media-invalid", "WebP structure is invalid");
  const format = buffer.toString("ascii", 12, 16);
  let width: number;
  let height: number;
  let frames = 1;
  if (format === "VP8X") {
    width = buffer.readUIntLE(24, 3) + 1;
    height = buffer.readUIntLE(27, 3) + 1;
    if ((buffer[20]! & 0x02) !== 0) {
      frames = 0;
      let offset = 12;
      while (offset + 8 <= buffer.length) {
        const chunk = buffer.toString("ascii", offset, offset + 4);
        const length = buffer.readUInt32LE(offset + 4);
        const end = offset + 8 + length + (length & 1);
        if (end > buffer.length)
          throw new AppError("media-invalid", "WebP chunk is invalid");
        if (chunk === "ANMF") frames += 1;
        if (frames > MAX_GIF_FRAMES)
          throw new AppError(
            "media-invalid",
            "WebP frame count exceeds MVP limits",
          );
        offset = end;
      }
      if (frames === 0)
        throw new AppError("media-invalid", "WebP animation has no frames");
    }
  } else if (format === "VP8 ") {
    const start = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (start < 0 || start + 7 > buffer.length)
      throw new AppError("media-invalid", "WebP dimensions are invalid");
    width = buffer.readUInt16LE(start + 3) & 0x3fff;
    height = buffer.readUInt16LE(start + 5) & 0x3fff;
  } else if (format === "VP8L") {
    if (buffer[20] !== 0x2f)
      throw new AppError("media-invalid", "WebP dimensions are invalid");
    const bits = buffer.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else {
    throw new AppError("media-invalid", "WebP encoding is unsupported");
  }
  dimensions(width, height);
  if (frames > MAX_GIF_FRAMES)
    throw new AppError("media-invalid", "WebP frame count exceeds MVP limits");
  animatedPixels(width, height, frames);
  return { mimeType: "image/webp", width, height, frames };
}

function sniffImage(buffer: Buffer): ImageInfo | null {
  return png(buffer) ?? jpeg(buffer) ?? gif(buffer) ?? webp(buffer);
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile())
      total += Number(lstatSync(child, { bigint: true }).size);
  }
  return total;
}

export class MediaStore {
  readonly #dataRoot: string;
  readonly #objectsRoot: string;
  readonly #temporaryRoot: string;
  readonly #sessionsRoot: string;

  public constructor(
    dataRoot: string,
    readonly minimumFreeBytes = 0,
  ) {
    this.#dataRoot = dataRoot;
    const mediaRoot = join(dataRoot, "media");
    this.#objectsRoot = join(mediaRoot, "objects");
    this.#temporaryRoot = join(mediaRoot, "tmp");
    this.#sessionsRoot = join(dataRoot, "pi-sessions");
    privateDirectory(mediaRoot);
    privateDirectory(this.#objectsRoot);
    privateDirectory(this.#temporaryRoot);
    for (const entry of readdirSync(this.#temporaryRoot))
      rmSync(join(this.#temporaryRoot, entry), {
        recursive: true,
        force: true,
      });
    syncDirectory(this.#temporaryRoot);
  }

  public cleanupUnreferenced(referenced: ReadonlySet<string>): number {
    let removed = 0;
    for (const owner of readdirSync(this.#objectsRoot, {
      withFileTypes: true,
    })) {
      if (!owner.isDirectory() || !USER_PATTERN.test(owner.name)) continue;
      const ownerRoot = join(this.#objectsRoot, owner.name);
      let ownerRemoved = false;
      for (const object of readdirSync(ownerRoot, { withFileTypes: true })) {
        const key = `${owner.name}/${object.name}`;
        if (
          object.isFile() &&
          OBJECT_PATTERN.test(object.name) &&
          !referenced.has(key)
        ) {
          unlinkSync(join(ownerRoot, object.name));
          removed += 1;
          ownerRemoved = true;
        }
      }
      if (ownerRemoved) syncDirectory(ownerRoot);
    }
    return removed;
  }

  #checkCapacity(userId: string, incomingBytes: number): void {
    const stats = statfsSync(this.#dataRoot, { bigint: true });
    const free = stats.bavail * stats.bsize;
    if (free - BigInt(incomingBytes) < BigInt(this.minimumFreeBytes))
      throw new AppError("busy", "media storage free-space threshold reached");
    const userBytes =
      directoryBytes(join(this.#objectsRoot, userId)) +
      directoryBytes(join(this.#sessionsRoot, userId));
    if (userBytes + incomingBytes > MAX_USER_STORAGE_BYTES)
      throw new AppError(
        "busy",
        "user media and session storage limit reached",
      );
  }

  public assertAdmissionCapacity(userId: string): void {
    if (!USER_PATTERN.test(userId))
      throw new AppError("rejected", "media owner is invalid");
    this.#checkCapacity(userId, 0);
  }

  #finalize(
    userId: string,
    identifier: string,
    temporary: string,
    bytes: number,
    sha256: string,
    options: InboundMediaOptions,
  ): RuntimeArtifact {
    const buffer = readFileSync(temporary);
    let image: ImageInfo | null = null;
    let incompleteImage = false;
    try {
      image = sniffImage(buffer);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.message.endsWith(" is incomplete")
      ) {
        incompleteImage = true;
      } else {
        throw error;
      }
    }
    const advertisedMime = boundedMime(options.advertisedMime);
    if (options.expectImage === true && image === null && !incompleteImage) {
      throw new AppError(
        "media-invalid",
        "advertised image is invalid or unsupported",
      );
    }
    const ownerRoot = join(this.#objectsRoot, userId);
    privateDirectory(ownerRoot);
    const final = join(ownerRoot, `${identifier}.blob`);
    chmodSync(temporary, 0o400);
    renameSync(temporary, final);
    syncDirectory(ownerRoot);
    return {
      id: `artifact_${identifier}`,
      userId,
      storageKey: `${userId}/${identifier}.blob`,
      sha256,
      bytes,
      mediaKind: image === null ? "file" : "image",
      mimeType: image?.mimeType ?? advertisedMime,
      displayName: boundedDisplayName(options.displayName),
    };
  }

  public async ingest(
    userId: string,
    source: AsyncIterable<Uint8Array>,
    options: InboundMediaOptions = {},
  ): Promise<RuntimeArtifact> {
    if (!USER_PATTERN.test(userId))
      throw new AppError("media-invalid", "media owner is invalid");
    if (
      options.advertisedBytes !== undefined &&
      (!Number.isSafeInteger(options.advertisedBytes) ||
        options.advertisedBytes < 0 ||
        options.advertisedBytes > MAX_INPUT_ARTIFACT_BYTES)
    ) {
      throw new AppError(
        "media-invalid",
        "media object exceeds the 20 MiB limit",
      );
    }
    this.#checkCapacity(userId, options.advertisedBytes ?? 0);
    const identifier = randomUUID();
    const temporary = join(this.#temporaryRoot, `${identifier}.tmp`);
    const descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const value of source) {
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > MAX_INPUT_ARTIFACT_BYTES)
          throw new AppError(
            "media-invalid",
            "media object exceeds the 20 MiB limit",
          );
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length)
          offset += writeSync(descriptor, chunk, offset, chunk.length - offset);
      }
      if (bytes === 0)
        throw new AppError("media-invalid", "media object is empty");
      if (
        options.advertisedBytes !== undefined &&
        bytes !== options.advertisedBytes
      )
        throw new AppError(
          "media-invalid",
          "media object size changed during download",
        );
      this.#checkCapacity(userId, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      return this.#finalize(
        userId,
        identifier,
        temporary,
        bytes,
        hash.digest("hex"),
        options,
      );
    } catch (error) {
      try {
        closeSync(descriptor);
      } catch {}
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  public promotePublished(
    userId: string,
    sourcePath: string,
    displayName?: string,
  ): RuntimeArtifact {
    if (!USER_PATTERN.test(userId) || dirname(sourcePath) === sourcePath)
      throw new Error("published artifact path is invalid");
    const sourceName = basename(sourcePath);
    if (!/^[a-f0-9]{32}\.blob$/u.test(sourceName))
      throw new Error("published artifact name is invalid");
    const source = lstatSync(sourcePath, { bigint: true });
    const uid = process.getuid?.();
    if (
      !source.isFile() ||
      source.isSymbolicLink() ||
      source.nlink !== 1n ||
      source.size > BigInt(MAX_OUTBOUND_ARTIFACT_BYTES) ||
      (uid !== undefined && source.uid !== BigInt(uid)) ||
      (source.mode & 0o077n) !== 0n
    ) {
      throw new Error("published artifact is unsafe");
    }
    const bytes = Number(source.size);
    this.#checkCapacity(userId, bytes);
    const identifier = randomUUID();
    const temporary = join(this.#temporaryRoot, `${identifier}.tmp`);
    const target = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    const input = openSync(
      sourcePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const hash = createHash("sha256");
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let copied = 0;
      for (;;) {
        const count = readSync(input, buffer, 0, buffer.length, null);
        if (count === 0) break;
        copied += count;
        if (copied > MAX_OUTBOUND_ARTIFACT_BYTES)
          throw new Error("published artifact exceeds its bound");
        hash.update(buffer.subarray(0, count));
        let offset = 0;
        while (offset < count)
          offset += writeSync(target, buffer, offset, count - offset);
      }
      if (
        copied !== bytes ||
        fstatSync(input, { bigint: true }).size !== source.size
      )
        throw new Error("published artifact changed during promotion");
      fsyncSync(target);
      closeSync(input);
      closeSync(target);
      return this.#finalize(
        userId,
        identifier,
        temporary,
        bytes,
        hash.digest("hex"),
        {
          displayName:
            displayName ?? `published-${sourceName.slice(0, 12)}.bin`,
        },
      );
    } catch (error) {
      try {
        closeSync(input);
      } catch {}
      try {
        closeSync(target);
      } catch {}
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  public objectPath(artifact: RuntimeArtifact): string {
    if (!USER_PATTERN.test(artifact.userId))
      throw new Error("artifact owner is invalid");
    const ownerRoot = join(this.#objectsRoot, artifact.userId);
    const child = relative(
      ownerRoot,
      join(this.#objectsRoot, artifact.storageKey),
    );
    const match = OBJECT_PATTERN.exec(child);
    if (match === null || child.includes("/"))
      throw new Error("artifact storage key is invalid");
    const path = join(ownerRoot, child);
    const metadata = lstatSync(path, { bigint: true });
    const uid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      metadata.size !== BigInt(artifact.bytes) ||
      (uid !== undefined && metadata.uid !== BigInt(uid)) ||
      (metadata.mode & 0o077n) !== 0n ||
      realpathSync(path) !== path
    ) {
      throw new Error("artifact object is unsafe");
    }
    return path;
  }

  public imageData(artifact: RuntimeArtifact): string {
    if (
      artifact.mediaKind !== "image" ||
      artifact.bytes > MAX_INPUT_ARTIFACT_BYTES
    )
      throw new Error("artifact is not a native input image");
    const bytes = readFileSync(this.objectPath(artifact));
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
      throw new Error("artifact digest changed");
    return bytes.toString("base64");
  }

  public verifiedObjectPath(artifact: RuntimeArtifact): string {
    const path = this.objectPath(artifact);
    const descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const hash = createHash("sha256");
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let bytes = 0;
      for (;;) {
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (count === 0) break;
        bytes += count;
        hash.update(buffer.subarray(0, count));
      }
      if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256)
        throw new Error("artifact digest changed");
      return path;
    } finally {
      closeSync(descriptor);
    }
  }

  public materializeInbox(
    artifact: RuntimeArtifact,
    inbox: string,
    ordinal: number,
  ): string {
    if (
      (artifact.mediaKind !== "file" && artifact.mediaKind !== "image") ||
      ordinal < 0 ||
      ordinal >= MAX_INPUT_ARTIFACTS
    )
      throw new Error("inbox artifact is invalid");
    const name = `${ordinal + 1}-${artifact.id.slice(-12)}.bin`;
    const targetPath = join(inbox, name);
    const source = openSync(
      this.objectPath(artifact),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const target = openSync(
      targetPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o400,
    );
    const hash = createHash("sha256");
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let copied = 0;
      for (;;) {
        const count = readSync(source, buffer, 0, buffer.length, null);
        if (count === 0) break;
        copied += count;
        hash.update(buffer.subarray(0, count));
        let offset = 0;
        while (offset < count)
          offset += writeSync(target, buffer, offset, count - offset);
      }
      if (copied !== artifact.bytes || hash.digest("hex") !== artifact.sha256)
        throw new Error("inbox artifact size changed");
      fsyncSync(target);
    } finally {
      closeSync(source);
      closeSync(target);
    }
    syncDirectory(inbox);
    return `/inbox/${name}`;
  }

  public discard(artifact: RuntimeArtifact): void {
    try {
      unlinkSync(this.objectPath(artifact));
      syncDirectory(join(this.#objectsRoot, artifact.userId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
