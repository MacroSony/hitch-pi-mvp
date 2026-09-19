import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { loadConfig } from "../src/config/config.js";
import { HitchStore } from "../src/app/store.js";
import { controlSocketPath } from "../src/local/socket.js";

const mainPath = fileURLToPath(new URL("../src/main.js", import.meta.url));

interface MainFixture {
  readonly root: string;
  readonly dataRoot: string;
  readonly piProfileDir: string;
  readonly workspace: string;
  readonly configPath: string;
  readonly socketPath: string;
}

function createMainFixture(): MainFixture {
  const root = mkdtempSync(join(tmpdir(), "hitch-local-main-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  const piProfileDir = join(root, "pi-profile");
  const workspace = join(root, "workspace");
  mkdirSync(piProfileDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      dataRoot,
      piProfileDir,
      minimumFreeBytes: 0,
      telegramAccounts: [
        { id: "primary", botTokenEnv: "HITCH_MAIN_UNSET_TOKEN" },
      ],
      wechatAccounts: [],
      users: [
        {
          id: "alice",
          workspace,
          telegram: {
            account: "primary",
            userId: "101",
            privateChatId: "101",
          },
        },
      ],
      localControl: {
        callers: [
          {
            id: "operator",
            tokenEnv: "HITCH_LOCAL_TEST_TOKEN",
            userIds: ["alice"],
            actions: ["targets.list"],
          },
        ],
      },
    })}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    dataRoot,
    piProfileDir,
    workspace,
    configPath,
    socketPath: controlSocketPath(dataRoot),
  };
}

test("config check mode ignores localControl and creates no listener", () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-local-main-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  const piProfileDir = join(root, "pi-profile");
  const workspace = join(root, "workspace");
  mkdirSync(piProfileDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
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
          telegram: {
            account: "primary",
            userId: "101",
            privateChatId: "101",
          },
        },
      ],
      localControl: {
        callers: [
          {
            id: "operator",
            tokenEnv: "HITCH_CONTROL_UNSET_TEST_TOKEN",
            userIds: ["alice"],
            actions: ["targets.list", "notify"],
          },
        ],
      },
    })}\n`,
    { mode: 0o600 },
  );

  const result = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("../src/main.js", import.meta.url)),
      "--config",
      configPath,
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "initialized",
    schemaVersion: 1,
    users: 1,
    endpoints: 1,
  });
  assert.equal(existsSync(join(dataRoot, "control", "hitch.sock")), false);
  assert.equal(existsSync(join(dataRoot, "control")), false);
});

test("startup listen failure leaves admitted application work queued", () => {
  const fixture = createMainFixture();
  try {
    const config = loadConfig(fixture.configPath);
    const foundation = bootstrapFoundation(config);
    let turnId: string;
    try {
      const store = new HitchStore(foundation.database);
      const endpoint = store.resolveTelegramEndpoint("primary", "101", "101");
      assert.ok(endpoint);
      const admitted = store.admitPrompt(
        {
          endpoint,
          idempotencyKey: "seed-main-1",
          contentDigest: "a".repeat(64),
        },
        "seed startup cleanup",
      );
      assert.equal(admitted.duplicate, false);
      turnId = admitted.turnId;
    } finally {
      foundation.close();
    }

    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        mainPath,
        "--config",
        fixture.configPath,
        "--fake-channels",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
          HITCH_LOCAL_TEST_TOKEN: "short",
          HITCH_MAIN_UNSET_TOKEN: "fixture-telegram-token-never-used",
        },
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /must be 32\.\.4096 UTF-8 bytes/u);

    const reopened = bootstrapFoundation(loadConfig(fixture.configPath));
    try {
      const row = reopened.database.connection
        .prepare("SELECT state, outcome FROM turns WHERE id = ?")
        .get(turnId) as { state: string; outcome: string | null } | undefined;
      assert.equal(row?.state, "queued");
      assert.equal(row?.outcome, null);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
