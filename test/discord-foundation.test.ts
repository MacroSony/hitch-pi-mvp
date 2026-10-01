import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { validateTopology } from "../src/foundation/filesystem.js";

function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function setup(): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "hitch-discord-foundation-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  const piProfileDir = join(root, "pi");
  const aliceWorkspace = join(root, "alice");
  const bobWorkspace = join(root, "bob");
  for (const path of [piProfileDir, aliceWorkspace, bobWorkspace])
    directory(path);
  return {
    schemaVersion: 1,
    dataRoot,
    piProfileDir,
    minimumFreeBytes: 0,
    telegramAccounts: [],
    wechatAccounts: [],
    discordAccounts: [{ id: "luna", botTokenEnv: "HITCH_TEST_DISCORD_TOKEN" }],
    users: [
      {
        id: "alice",
        workspace: aliceWorkspace,
        discord: {
          mode: "server",
          account: "luna",
          guildId: "123456789012345678",
          channelIds: ["123456789012345679", "123456789012345680"],
          adminUserIds: ["123456789012345681"],
        },
      },
    ],
  };
}

test("Discord config publishes one owner-wide server with destination endpoints", () => {
  const raw = setup();
  const config = parseConfig(raw);
  const topology = validateTopology(config);
  assert.equal(topology.users[0]?.scopeKind, "discord-server");
  assert.deepEqual(
    topology.users[0]?.endpoints.map((endpoint) => [
      endpoint.kind,
      endpoint.discordMode,
      endpoint.platformUserId,
      endpoint.privateChatId,
      JSON.parse(endpoint.tupleKey),
    ]),
    [
      [
        "discord",
        "server",
        "123456789012345678",
        "123456789012345679",
        [
          "discord",
          "luna",
          "server",
          "123456789012345678",
          "123456789012345679",
        ],
      ],
      [
        "discord",
        "server",
        "123456789012345678",
        "123456789012345680",
        [
          "discord",
          "luna",
          "server",
          "123456789012345678",
          "123456789012345680",
        ],
      ],
    ],
  );

  const foundation = bootstrapFoundation(config);
  try {
    const user = foundation.database.connection
      .prepare("SELECT scope_kind FROM users WHERE id = 'alice'")
      .get() as { scope_kind: string };
    assert.equal(user.scope_kind, "discord-server");
    assert.equal(
      (
        foundation.database.connection
          .prepare(
            "SELECT count(*) AS count FROM channel_endpoints WHERE kind = 'discord'",
          )
          .get() as { count: bigint }
      ).count,
      2n,
    );
    assert.deepEqual(
      foundation.database.connection.prepare("PRAGMA foreign_key_check").all(),
      [],
    );
  } finally {
    foundation.close();
  }
});

test("Discord topology rejects invalid snowflakes, mixed channels, and duplicate scopes", () => {
  const invalidSnowflake = setup();
  (invalidSnowflake.users as Array<Record<string, unknown>>)[0]!.discord = {
    mode: "dm",
    account: "luna",
    userId: "00000000000000001",
    channelId: "123456789012345678",
  };
  assert.throws(
    () => parseConfig(invalidSnowflake),
    /canonical nonzero Discord snowflake/u,
  );

  const mixed = setup();
  const mixedUser = (mixed.users as Array<Record<string, unknown>>)[0]!;
  mixedUser.telegram = { account: "missing", userId: "1", privateChatId: "1" };
  assert.throws(() => parseConfig(mixed), /Discord cannot be mixed/u);

  const duplicate = setup();
  (duplicate.users as Array<Record<string, unknown>>).push({
    id: "bob",
    workspace: (setup().users as Array<Record<string, unknown>>)[0]!.workspace,
    discord: {
      mode: "server",
      account: "luna",
      guildId: "123456789012345678",
      channelIds: ["123456789012345682"],
      adminUserIds: ["123456789012345683"],
    },
  });
  assert.throws(() => parseConfig(duplicate), /Discord scopes/u);
});

test("historical Discord scope cannot be reassigned or expose a private owner", () => {
  const raw = setup();
  const first = bootstrapFoundation(parseConfig(raw));
  first.close();

  const bob = setup();
  bob.dataRoot = raw.dataRoot;
  bob.piProfileDir = raw.piProfileDir;
  const bobUser = (bob.users as Array<Record<string, unknown>>)[0]!;
  bobUser.id = "bob";
  assert.throws(
    () => bootstrapFoundation(parseConfig(bob)),
    /cannot be reassigned or split/u,
  );

  const legacy = setup();
  legacy.telegramAccounts = [
    { id: "primary", botTokenEnv: "HITCH_TEST_TELEGRAM_TOKEN" },
  ];
  legacy.users = [
    {
      id: "alice",
      workspace: (raw.users as Array<Record<string, unknown>>)[0]!.workspace,
      telegram: { account: "primary", userId: "123", privateChatId: "123" },
    },
  ];
  const privateFoundation = bootstrapFoundation(parseConfig(legacy));
  privateFoundation.close();
  const discord = setup();
  discord.dataRoot = legacy.dataRoot;
  discord.piProfileDir = legacy.piProfileDir;
  (discord.users as Array<Record<string, unknown>>)[0]!.workspace = (
    legacy.users as Array<Record<string, unknown>>
  )[0]!.workspace;
  assert.throws(
    () => bootstrapFoundation(parseConfig(discord)),
    /published workspace identity changed|scope/u,
  );
});

test("Discord scope bindings survive owner republishes and disabled endpoints", () => {
  const raw = setup();
  const user = (raw.users as Array<Record<string, unknown>>)[0]!;
  const discord = user.discord as Record<string, unknown>;
  const first = bootstrapFoundation(parseConfig(raw));
  first.close();

  discord.guildId = "123456789012345682";
  discord.channelIds = ["123456789012345683"];
  assert.throws(
    () => bootstrapFoundation(parseConfig(raw)),
    /owner scope cannot be changed/u,
  );

  // The old endpoint is disabled, but remains a durable owner binding.
  const other = setup();
  const bob = (other.users as Array<Record<string, unknown>>)[0]!;
  bob.id = "bob";
  bob.discord = {
    mode: "server",
    account: "luna",
    guildId: "123456789012345687",
    channelIds: ["123456789012345688"],
    adminUserIds: ["123456789012345689"],
  };
  raw.users = [bob];
  const removed = bootstrapFoundation(parseConfig(raw));
  removed.close();
  raw.users = [user];
  assert.throws(
    () => bootstrapFoundation(parseConfig(raw)),
    /owner scope cannot be changed/u,
  );

  const dmRaw = setup();
  const dmUser = (dmRaw.users as Array<Record<string, unknown>>)[0]!;
  dmUser.discord = {
    mode: "dm",
    account: "luna",
    userId: "123456789012345684",
    channelId: "123456789012345685",
  };
  const dmFirst = bootstrapFoundation(parseConfig(dmRaw));
  dmFirst.close();
  (dmUser.discord as Record<string, unknown>).userId = "123456789012345686";
  assert.throws(
    () => bootstrapFoundation(parseConfig(dmRaw)),
    /owner scope cannot be changed/u,
  );
});

test("schema 9 keeps Discord source JSON bounded by the database check", () => {
  const foundation = bootstrapFoundation(parseConfig(setup()));
  try {
    const endpoint = foundation.database.connection
      .prepare("SELECT id, user_id FROM channel_endpoints LIMIT 1")
      .get() as { id: string; user_id: string };
    const sessionId = "discord-session";
    foundation.database.connection
      .prepare(
        "INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at) VALUES (?, ?, 'main', 'pi', 'active', 1, 1)",
      )
      .run(sessionId, endpoint.user_id);
    assert.throws(
      () =>
        foundation.database.connection
          .prepare(
            "INSERT INTO turns(id, user_id, session_id, endpoint_id, idempotency_key, content_digest, prompt_text, discord_source, ordinal, state, created_at, updated_at) VALUES ('bad', ?, ?, ?, 'm', 'd', 'p', 'not-json', 1, 'queued', 1, 1)",
          )
          .run(endpoint.user_id, sessionId, endpoint.id),
      /CHECK constraint failed/u,
    );
  } finally {
    foundation.close();
  }
});
