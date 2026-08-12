import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import {
  NativePiRuntime,
  validatePiProfile,
} from "../src/pi/native-runtime.js";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

test("Pi profile validation is content-free and gives the attended recovery path", () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-profile-test-"));
  chmodSync(root, 0o700);
  const profile = join(root, "profile");
  privateDirectory(profile);
  const auth = join(profile, "auth.json");
  writeFileSync(auth, "{}\n", { mode: 0o600 });
  validatePiProfile(profile);

  chmodSync(auth, 0o644);
  assert.throws(() => validatePiProfile(profile), /unsafe JSON file/u);
  chmodSync(auth, 0o600);
  writeFileSync(auth, "{broken\n", { mode: 0o600 });
  assert.throws(
    () => validatePiProfile(profile),
    /restore the operator backup or log in again/u,
  );
});

test("production sandbox sources exactly match the reviewed Phase 0 assets", () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  for (const name of [
    "hitch-sandbox.ts",
    "sandbox-backend.mjs",
    "sandbox-worker.mjs",
    "secure-bwrap-helper.c",
  ]) {
    assert.deepEqual(
      readFileSync(
        join(repository, "packages", "hitch-sandbox-extension", name),
      ),
      readFileSync(join(repository, "spikes", "p0-sandbox", name)),
      name,
    );
  }

  const staged = join(repository, "dist", "sandbox");
  for (const name of [
    "hitch-sandbox.ts",
    "sandbox-backend.mjs",
    "sandbox-worker.mjs",
  ]) {
    assert.equal(statSync(join(staged, name)).mode & 0o777, 0o444);
  }
  assert.equal(
    statSync(join(staged, "secure-bwrap-helper")).mode & 0o777,
    0o555,
  );
});

test(
  "opt-in native startup attests Pi and the Bubblewrap extension",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hitch-native-test-"));
    chmodSync(root, 0o700);
    const dataRoot = join(root, "data");
    const profile = join(root, "profile");
    privateDirectory(dataRoot);
    privateDirectory(profile);
    writeFileSync(join(profile, "auth.json"), "{}\n", { mode: 0o600 });
    await assert.rejects(
      () =>
        NativePiRuntime.create({
          dataRoot,
          piProfileDir: profile,
          turnTimeoutMs: 2_000,
        }),
      /no authenticated available model/u,
    );
  },
);

test(
  "opt-in publication snapshot uses the production descriptor-confined helper",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1" },
  async () => {
    const repository = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const assets = join(repository, "dist", "sandbox");
    const root = mkdtempSync(join(tmpdir(), "hitch-publish-test-"));
    chmodSync(root, 0o700);
    const workspace = join(root, "workspace");
    const inbox = join(root, "inbox");
    const publishRoot = join(root, "publish");
    for (const path of [workspace, inbox, publishRoot]) privateDirectory(path);
    writeFileSync(join(workspace, "result.txt"), "publication-check", {
      mode: 0o600,
    });
    const worker = join(assets, "sandbox-worker.mjs");
    const helper = join(assets, "secure-bwrap-helper");
    const sha256 = (path: string): string =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    const artifactId = randomBytes(16).toString("hex");
    try {
      const backend = (await import(
        pathToFileURL(join(assets, "sandbox-backend.mjs")).href
      )) as {
        executeSandboxRequest(
          input: Record<string, unknown>,
          request: Record<string, unknown>,
        ): Promise<unknown>;
        activeSandboxUnitCount(): number;
      };
      const result = (await backend.executeSandboxRequest(
        {
          workspace,
          inbox,
          publishRoot,
          worker,
          helper,
          log: join(root, "sandbox.log"),
          turnHandle: randomBytes(16).toString("hex"),
          workerSha256: sha256(worker),
          helperSha256: sha256(helper),
          temporaryBytes: 4 * 1024 * 1024,
          memoryBytes: 256 * 1024 * 1024,
          maximumProcesses: 32,
          wallMilliseconds: 8_000,
        },
        {
          operation: "hitch_publish",
          input: { path: "result.txt", artifactId },
        },
      )) as { bytes: number; sha256: string };
      const artifact = join(publishRoot, `${artifactId}.blob`);
      assert.equal(result.bytes, 17);
      assert.equal(result.sha256, sha256(artifact));
      assert.equal(readFileSync(artifact, "utf8"), "publication-check");
      assert.equal(backend.activeSandboxUnitCount(), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
