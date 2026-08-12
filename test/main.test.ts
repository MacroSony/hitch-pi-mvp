import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

test("CLI initializes and reopens a content-free foundation", () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-main-test-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  const piProfileDir = join(root, "pi-profile");
  const workspace = join(root, "workspace");
  privateDirectory(piProfileDir);
  privateDirectory(workspace);
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      dataRoot,
      piProfileDir,
      minimumFreeBytes: 0,
      telegramAccounts: [
        { id: "primary", botTokenEnv: "HITCH_MAIN_TEST_TOKEN" },
      ],
      wechatAccounts: [],
      users: [
        {
          id: "alice",
          workspace,
          telegram: { account: "primary", userId: "101", privateChatId: "101" },
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        mainPath,
        "--config",
        configPath,
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "initialized",
      schemaVersion: 1,
      users: 1,
      endpoints: 1,
    });
  }
  assert.equal(existsSync(join(dataRoot, "hitch.sqlite")), true);
});
