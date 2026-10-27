import {
  closeSync,
  constants,
  fchmodSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const DEADLINE_MS = 10_000;
const INVALID = "Generated video is invalid or unsupported.";
type VideoInfo = {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
};

function reject(): never {
  throw new Error(INVALID);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function boxEnd(bytes: Uint8Array, start: number, end: number): number {
  if (end - start < 8) reject();
  const size32 = new DataView(
    bytes.buffer,
    bytes.byteOffset + start,
    4,
  ).getUint32(0);
  const type = fourcc(bytes, start + 4);
  let header = 8;
  let size = size32;
  if (size32 === 1) {
    if (end - start < 16) reject();
    const view = new DataView(bytes.buffer, bytes.byteOffset + start + 8, 8);
    const wide = view.getBigUint64(0);
    if (wide > BigInt(Number.MAX_SAFE_INTEGER)) reject();
    size = Number(wide);
    header = 16;
  } else if (size32 === 0) {
    size = end - start;
  }
  if (type === "uuid") header += 16;
  if (size < header || size > end - start) reject();
  return start + size;
}

const CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
  "mvex",
  "moof",
  "traf",
  "mfra",
]);
function validateBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth = 0,
): Set<string> {
  if (depth > 12) reject();
  const types = new Set<string>();
  let offset = start;
  while (offset < end) {
    const type = fourcc(bytes, offset + 4);
    const next = boxEnd(bytes, offset, end);
    types.add(type);
    if (CONTAINERS.has(type))
      validateBoxes(
        bytes,
        offset +
          (bytes[offset] === 0 &&
          bytes[offset + 1] === 0 &&
          bytes[offset + 2] === 0 &&
          bytes[offset + 3] === 1
            ? 16
            : 8),
        next,
        depth + 1,
      );
    offset = next;
  }
  if (offset !== end) reject();
  return types;
}

function sanityCheck(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 16 ||
    bytes.byteLength > MAX_BYTES ||
    fourcc(bytes, 4) !== "ftyp"
  )
    reject();
  const first = boxEnd(bytes, 0, bytes.length);
  if (first < 16) reject();
  let offset = first;
  let moov = false;
  let mdat = false;
  while (offset < bytes.length) {
    const type = fourcc(bytes, offset + 4);
    const next = boxEnd(bytes, offset, bytes.length);
    if (type === "moov") {
      moov = true;
      validateBoxes(bytes, offset + 8, next);
    } else if (type === "mdat") mdat = true;
    offset = next;
  }
  if (offset !== bytes.length || !moov || !mdat) reject();
}

function parseRate(value: unknown): number {
  if (typeof value !== "string") reject();
  const match = /^(\d{1,12})\/(\d{1,12})$/.exec(value);
  if (!match) reject();
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  const fps = numerator / denominator;
  if (!Number.isFinite(fps) || numerator <= 0 || denominator <= 0 || fps > 60)
    reject();
  return fps;
}

function parseProbe(text: string): VideoInfo {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return reject();
  }
  if (!data || typeof data !== "object") reject();
  const root = data as { streams?: unknown; format?: { duration?: unknown } };
  if (
    !Array.isArray(root.streams) ||
    !root.format ||
    typeof root.format !== "object"
  )
    reject();
  const streams = root.streams as Array<Record<string, unknown>>;
  const video = streams.filter((stream) => stream.codec_type === "video");
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  if (
    video.length !== 1 ||
    audio.length !== 1 ||
    video[0]!.codec_name !== "h264" ||
    audio[0]!.codec_name !== "aac"
  )
    reject();
  const width = video[0]!.width;
  const height = video[0]!.height;
  const duration = Number(root.format.duration);
  const fps = parseRate(video[0]!.avg_frame_rate);
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 1536 ||
    height > 1536 ||
    width * height > 4_000_000 ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    duration > 16
  )
    reject();
  return { width, height, duration, fps, hasAudio: true };
}

async function probe(fd: number): Promise<string> {
  return await new Promise((resolve, rejectPromise) => {
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    let closed = false;
    const child = spawn(
      "/usr/bin/prlimit",
      [
        "--as=536870912",
        "--cpu=10",
        "--",
        "/usr/bin/bwrap",
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--setenv",
        "LD_LIBRARY_PATH",
        "/usr/lib/x86_64-linux-gnu/blas:/usr/lib/x86_64-linux-gnu/lapack",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--ro-bind-data",
        "3",
        "/input.mp4",
        "/usr/bin/ffprobe",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "mov",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration",
        "-of",
        "json",
        "/input.mp4",
      ],
      {
        env: {},
        stdio: ["ignore", "pipe", "pipe", fd],
        windowsHide: true,
      },
    );
    const timer = setTimeout(() => abort(new Error(INVALID)), DEADLINE_MS);
    const abort = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (closed) rejectPromise(error);
      else child.once("close", () => rejectPromise(error));
    };
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      if (error) return abort(error);
      settled = true;
      clearTimeout(timer);
      resolve(result!);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT)
        return finish(new Error(INVALID));
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT) finish(new Error(INVALID));
    });
    child.once("error", () => finish(new Error(INVALID)));
    child.once("close", (code) => {
      closed = true;
      if (code !== 0) finish(new Error(INVALID));
      else finish(undefined, stdout.toString("utf8"));
    });
  });
}

/**
 * Inspect bounded generated MP4 metadata only; this is not decoded-pixel or
 * visual-quality validation, and is not a safe normalizer for untrusted user
 * reference video. That needs a separately isolated route.
 */
export async function inspectGeneratedVideo(
  bytes: Uint8Array,
): Promise<VideoInfo> {
  let directory: string | undefined;
  let fd: number | undefined;
  try {
    sanityCheck(bytes);
    directory = mkdtempSync(join("/tmp", "hitch-generated-video-"));
    const dirFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fchmodSync(dirFd, 0o700);
    } finally {
      closeSync(dirFd);
    }
    const input = join(directory, "input.mp4");
    fd = openSync(
      input,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < bytes.byteLength)
      offset += writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    const probeFd = fd;
    const output = await probe(probeFd);
    closeSync(probeFd);
    fd = undefined;
    return parseProbe(output);
  } catch {
    return reject();
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* best-effort own descriptor cleanup */
      }
    if (directory !== undefined)
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* best-effort own scratch cleanup */
      }
  }
}
