import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inspectGeneratedVideo } from "../src/comfyui/video.js";

const invalid = /Generated video is invalid or unsupported\./;
function minimalMp4(): Uint8Array {
  const box = (type: string, body = Buffer.alloc(0)) => {
    const result = Buffer.alloc(8 + body.length);
    result.writeUInt32BE(result.length, 0);
    result.write(type, 4, "ascii");
    body.copy(result, 8);
    return result;
  };
  return Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\x02\0isom", "binary")),
    box("moov"),
    box("mdat"),
  ]);
}

test("generated-video inspector rejects oversize, invalid brands, and malformed atoms before invoking a probe", async () => {
  await assert.rejects(
    inspectGeneratedVideo(new Uint8Array(10 * 1024 * 1024 + 1)),
    invalid,
  );
  await assert.rejects(
    inspectGeneratedVideo(Buffer.from("not an mp4")),
    invalid,
  );
  const truncated = minimalMp4().slice(0, 18);
  await assert.rejects(inspectGeneratedVideo(truncated), invalid);
  const badBox = minimalMp4();
  new DataView(badBox.buffer, badBox.byteOffset).setUint32(0, 0xffffffff);
  await assert.rejects(inspectGeneratedVideo(badBox), invalid);
  const badBrand = minimalMp4();
  badBrand.set(Buffer.from("qt  "), 16);
  await assert.rejects(inspectGeneratedVideo(badBrand), invalid);
  await assert.rejects(inspectGeneratedVideo(minimalMp4()), invalid);
});

function run(
  command: string,
  args: string[],
  timeout: number,
  input?: Uint8Array,
): Promise<{ code: number | null; output: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {},
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Fixture subprocess timed out"));
    }, timeout);
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks) });
    });
    if (input) child.stdin!.end(input);
  });
}

const sandboxTests = process.env.HITCH_RUN_SANDBOX_TESTS === "1";
test(
  "opt-in isolated ffprobe and full decode accept generated H.264/AAC and reject invalid input",
  { skip: !sandboxTests, timeout: 90_000 },
  async (t) => {
    const root = mkdtempSync(join("/tmp", "hitch-video-fixtures-"));
    chmodSync(root, 0o700);
    const prior = new Set(
      readdirSync("/tmp").filter((name) =>
        name.startsWith("hitch-generated-video-"),
      ),
    );
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      const remaining = readdirSync("/tmp").filter((name) =>
        name.startsWith("hitch-generated-video-"),
      );
      assert.deepEqual(
        remaining.filter((name) => !prior.has(name)),
        [],
      );
    });
    const make = async (name: string, args: string[]) => {
      const path = join(root, name);
      const result = await run(
        "/usr/bin/ffmpeg",
        ["-nostdin", "-hide_banner", "-loglevel", "error", ...args, "-y", path],
        90_000,
      );
      assert.equal(
        result.code,
        0,
        `local CPU fixture ffmpeg failed: ${result.output.toString("utf8")}`,
      );
      const { readFileSync } = await import("node:fs");
      return new Uint8Array(readFileSync(path));
    };
    const valid = await make("valid.mp4", [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=24:d=0.5",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "0.5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
    ]);
    assert.deepEqual(await inspectGeneratedVideo(valid), {
      width: 64,
      height: 64,
      duration: 0.5,
      fps: 24,
      hasAudio: true,
    });
    const zeroDuration = Buffer.from(valid);
    for (const tag of ["mvhd", "mdhd", "tkhd"]) {
      let cursor = 0;
      while ((cursor = zeroDuration.indexOf(tag, cursor)) !== -1) {
        const durationOffset = cursor + (tag === "tkhd" ? 24 : 20);
        zeroDuration.writeUInt32BE(0, durationOffset);
        cursor += 4;
      }
    }
    await assert.rejects(inspectGeneratedVideo(zeroDuration), invalid);
    const beforeAbort = new Set(
      readdirSync("/tmp").filter((name) =>
        name.startsWith("hitch-generated-video-"),
      ),
    );
    const controller = new AbortController();
    const aborted = inspectGeneratedVideo(valid, controller.signal);
    controller.abort();
    await assert.rejects(aborted, invalid);
    assert.deepEqual(
      readdirSync("/tmp").filter(
        (name) =>
          name.startsWith("hitch-generated-video-") && !beforeAbort.has(name),
      ),
      [],
    );
    const corrupted = Buffer.from(valid);
    let boxOffset = 0;
    while (boxOffset + 8 <= corrupted.length) {
      const boxSize = corrupted.readUInt32BE(boxOffset);
      if (
        corrupted.toString("ascii", boxOffset + 4, boxOffset + 8) === "mdat"
      ) {
        corrupted.fill(0, boxOffset + 8, boxOffset + boxSize);
        break;
      }
      if (boxSize < 8) break;
      boxOffset += boxSize;
    }
    await assert.rejects(inspectGeneratedVideo(corrupted), invalid);
    const silent = await make("silent.mp4", [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=24:d=0.5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
    ]);
    await assert.rejects(inspectGeneratedVideo(silent), invalid);
    const mp3 = await make("mp3.mp4", [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=24:d=0.5",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "0.5",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "libmp3lame",
      "-shortest",
    ]);
    await assert.rejects(inspectGeneratedVideo(mp3), invalid);
    const long = await make("long.mp4", [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=1:d=17",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "17",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
    ]);
    await assert.rejects(inspectGeneratedVideo(long), invalid);
  },
);
