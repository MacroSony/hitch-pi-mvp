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
    box("ftyp", Buffer.alloc(8)),
    box("moov"),
    box("mdat"),
  ]);
}

test("generated-video inspector rejects oversize and structurally invalid data before invoking a probe", async () => {
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
  "opt-in isolated ffprobe accepts generated H.264/AAC and rejects unsupported tracks",
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
