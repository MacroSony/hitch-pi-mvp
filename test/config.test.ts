import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigError,
  loadConfig,
  parseConfig,
  readRequiredSecret,
} from "../src/config/config.js";

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    dataRoot: "/srv/hitch/data",
    piProfileDir: "/srv/hitch/pi-profile",
    minimumFreeBytes: 0,
    telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_TELEGRAM_TOKEN" }],
    wechatAccounts: [{ id: "primary", stateDir: "/srv/hitch/wechat" }],
    users: [
      {
        id: "alice",
        workspace: "/srv/hitch/workspaces/alice",
        telegram: { account: "primary", userId: "101", privateChatId: "101" },
        wechat: { account: "primary", userId: "wxid_alice" },
      },
    ],
  };
}

test("strict config accepts exact JSON and stores only secret references", () => {
  const config = parseConfig(validConfig());
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.maxConcurrentTurns, 2);
  assert.equal(config.telegramAccounts[0]?.botTokenEnv, "HITCH_TELEGRAM_TOKEN");
  assert.equal(
    readRequiredSecret("HITCH_TELEGRAM_TOKEN", {
      HITCH_TELEGRAM_TOKEN: "fixture-secret",
    }),
    "fixture-secret",
  );
  assert.throws(
    () => readRequiredSecret("HITCH_TELEGRAM_TOKEN", {}),
    ConfigError,
  );
});

test("strict config rejects unknown fields and unsafe identifiers", () => {
  const unknown = validConfig();
  unknown.extra = true;
  assert.throws(() => parseConfig(unknown), /unknown field/u);

  const numericRemote = validConfig();
  const users = numericRemote.users as Array<Record<string, unknown>>;
  const firstUser = users[0];
  assert.ok(firstUser !== undefined);
  firstUser.telegram = {
    account: "primary",
    userId: 101,
    privateChatId: "101",
  };
  assert.throws(() => parseConfig(numericRemote), /non-empty string/u);

  const control = validConfig();
  const controlUsers = control.users as Array<Record<string, unknown>>;
  const controlUser = controlUsers[0];
  assert.ok(controlUser !== undefined);
  controlUser.wechat = { account: "primary", userId: "wx\0alice" };
  assert.throws(() => parseConfig(control), /control characters/u);

  const path = validConfig();
  path.dataRoot = "/srv/hitch/../data";
  assert.throws(() => parseConfig(path), /normalized absolute path/u);
});

test("config bounds maxConcurrentTurns and lets operators override the default", () => {
  const defaulted = parseConfig(validConfig());
  assert.equal(defaulted.maxConcurrentTurns, 2);

  const raised = validConfig();
  raised.maxConcurrentTurns = 4;
  assert.equal(parseConfig(raised).maxConcurrentTurns, 4);

  const tooLow = validConfig();
  tooLow.maxConcurrentTurns = 0;
  assert.throws(() => parseConfig(tooLow), /safe integer from 1 to 8/u);

  const tooHigh = validConfig();
  tooHigh.maxConcurrentTurns = 9;
  assert.throws(() => parseConfig(tooHigh), /safe integer from 1 to 8/u);
});

test("config rejects duplicate tuples, missing endpoints, and unknown accounts", () => {
  const duplicate = validConfig();
  const users = duplicate.users as Array<Record<string, unknown>>;
  const first = users[0];
  assert.ok(first !== undefined);
  users.push({
    id: "bob",
    workspace: "/srv/hitch/workspaces/bob",
    telegram: first.telegram,
  });
  assert.throws(() => parseConfig(duplicate), /duplicate value/u);

  const missingEndpoint = validConfig();
  missingEndpoint.users = [
    { id: "alice", workspace: "/srv/hitch/workspaces/alice" },
  ];
  assert.throws(
    () => parseConfig(missingEndpoint),
    /at least one private endpoint/u,
  );

  const unknownAccount = validConfig();
  const unknownUsers = unknownAccount.users as Array<Record<string, unknown>>;
  const unknownUser = unknownUsers[0];
  assert.ok(unknownUser !== undefined);
  unknownUser.telegram = {
    account: "missing",
    userId: "101",
    privateChatId: "101",
  };
  assert.throws(() => parseConfig(unknownAccount), /unknown Telegram account/u);
});

test("loadConfig rejects malformed and oversized files", () => {
  const directory = mkdtempSync(join(tmpdir(), "hitch-config-test-"));
  chmodSync(directory, 0o700);
  const malformed = join(directory, "malformed.json");
  writeFileSync(malformed, "{", { mode: 0o600 });
  assert.throws(() => loadConfig(malformed), /not valid JSON/u);
  const oversized = join(directory, "oversized.json");
  writeFileSync(oversized, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
  assert.throws(() => loadConfig(oversized), /too large/u);
});

test("config validates optional webSearch configuration strictly", () => {
  const base = validConfig();
  const withoutWs = parseConfig(base);
  assert.equal(withoutWs.webSearch, undefined);

  const withWs = validConfig();
  withWs.webSearch = {
    provider: "tavily",
    apiKeyEnv: "TAVILY_API_KEY",
    enabledUsers: ["alice"],
  };
  const parsedWithWs = parseConfig(withWs);
  assert.deepEqual(parsedWithWs.webSearch, {
    provider: "tavily",
    apiKeyEnv: "TAVILY_API_KEY",
    enabledUsers: ["alice"],
  });

  const emptyUsers = validConfig();
  emptyUsers.webSearch = {
    provider: "tavily",
    apiKeyEnv: "TAVILY_API_KEY",
    enabledUsers: [],
  };
  assert.deepEqual(parseConfig(emptyUsers).webSearch?.enabledUsers, []);

  const invalidProvider = validConfig();
  invalidProvider.webSearch = {
    provider: "google",
    apiKeyEnv: "TAVILY_API_KEY",
    enabledUsers: ["alice"],
  };
  assert.throws(
    () => parseConfig(invalidProvider),
    /config\.webSearch\.provider/u,
  );

  const invalidEnv = validConfig();
  invalidEnv.webSearch = {
    provider: "tavily",
    apiKeyEnv: "tavily_api_key",
    enabledUsers: ["alice"],
  };
  assert.throws(
    () => parseConfig(invalidEnv),
    /uppercase environment variable name/u,
  );

  const unknownUser = validConfig();
  unknownUser.webSearch = {
    provider: "tavily",
    apiKeyEnv: "TAVILY_API_KEY",
    enabledUsers: ["bob"],
  };
  assert.throws(
    () => parseConfig(unknownUser),
    /references an unknown user: bob/u,
  );

  const duplicateUser = validConfig();
  duplicateUser.webSearch = {
    provider: "tavily",
    apiKeyEnv: "TAVILY_API_KEY",
    enabledUsers: ["alice", "alice"],
  };
  assert.throws(() => parseConfig(duplicateUser), /duplicate value/u);

  const extraKeys = validConfig();
  extraKeys.webSearch = {
    provider: "tavily",
    apiKeyEnv: "TAVILY_API_KEY",
    enabledUsers: ["alice"],
    extra: true,
  };
  assert.throws(() => parseConfig(extraKeys), /unknown field/u);
});

test("Forge is explicit, per-user, and never a host/plugin configuration surface", () => {
  assert.equal(parseConfig(validConfig()).forge, undefined);
  const config = {
    ...validConfig(),
    forge: { root: "/srv/hitch/forge", enabledUsers: ["alice"] },
  };
  assert.deepEqual(parseConfig(config).forge, config.forge);
  for (const forge of [
    { root: "relative", enabledUsers: ["alice"] },
    { root: "/srv/hitch/forge", enabledUsers: ["unknown"] },
    { root: "/srv/hitch/forge", enabledUsers: ["alice", "alice"] },
    { root: "/srv/hitch/forge", enabledUsers: ["alice"], subagents: true },
  ])
    assert.throws(() => parseConfig({ ...validConfig(), forge }), ConfigError);
  assert.deepEqual(
    parseConfig({ ...config, forge: { ...config.forge, enabledUsers: [] } })
      .forge?.enabledUsers,
    [],
  );
});
