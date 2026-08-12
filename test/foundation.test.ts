import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { parseConfig, type AppConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { openFoundationDatabase } from "../src/foundation/database.js";
import {
  FoundationError,
  validateTopology,
} from "../src/foundation/filesystem.js";

interface Fixture {
  readonly root: string;
  readonly dataRoot: string;
  readonly piProfileDir: string;
  readonly wechatStateDir: string;
  readonly aliceWorkspace: string;
  readonly bobWorkspace: string;
  readonly raw: Record<string, unknown>;
  config(): AppConfig;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hitch-foundation-test-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  const piProfileDir = join(root, "pi-profile");
  const wechatStateDir = join(root, "wechat-state");
  const aliceWorkspace = join(root, "alice-workspace");
  const bobWorkspace = join(root, "bob-workspace");
  for (const path of [
    piProfileDir,
    wechatStateDir,
    aliceWorkspace,
    bobWorkspace,
  ])
    privateDirectory(path);
  const raw: Record<string, unknown> = {
    schemaVersion: 1,
    dataRoot,
    piProfileDir,
    minimumFreeBytes: 0,
    telegramAccounts: [
      { id: "primary", botTokenEnv: "HITCH_TEST_TELEGRAM_TOKEN" },
    ],
    wechatAccounts: [{ id: "primary", stateDir: wechatStateDir }],
    users: [
      {
        id: "alice",
        workspace: aliceWorkspace,
        telegram: { account: "primary", userId: "101", privateChatId: "101" },
        wechat: { account: "primary", userId: "wxid_alice" },
      },
      {
        id: "bob",
        workspace: bobWorkspace,
        telegram: { account: "primary", userId: "202", privateChatId: "202" },
      },
    ],
  };
  return {
    root,
    dataRoot,
    piProfileDir,
    wechatStateDir,
    aliceWorkspace,
    bobWorkspace,
    raw,
    config: () => parseConfig(raw),
  };
}

function rowCount(
  database: DatabaseSync,
  table: string,
  enabled?: number,
): number {
  const sql =
    enabled === undefined
      ? `SELECT count(*) AS count FROM ${table}`
      : `SELECT count(*) AS count FROM ${table} WHERE enabled = ?`;
  const row = (
    enabled === undefined
      ? database.prepare(sql).get()
      : database.prepare(sql).get(enabled)
  ) as {
    count: bigint;
  };
  return Number(row.count);
}

test("foundation publishes two users, reopens deterministically, and keeps secrets out of SQLite", () => {
  const setup = fixture();
  const foundation = bootstrapFoundation(setup.config(), { now: () => 1_000 });
  assert.equal(rowCount(foundation.database.connection, "users"), 2);
  assert.equal(
    rowCount(foundation.database.connection, "channel_endpoints"),
    3,
  );
  assert.equal(rowCount(foundation.database.connection, "users", 1), 2);
  const foreignKeys = foundation.database.connection
    .prepare("PRAGMA foreign_keys")
    .get() as {
    foreign_keys: bigint;
  };
  assert.equal(foreignKeys.foreign_keys, 1n);
  const databasePath = foundation.database.path;
  foundation.close();

  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(databasePath).includes(
      Buffer.from("HITCH_TEST_TELEGRAM_TOKEN"),
    ),
    false,
  );
  assert.equal(
    readFileSync(databasePath).includes(Buffer.from("fixture-secret")),
    false,
  );

  const reopened = bootstrapFoundation(setup.config(), { now: () => 2_000 });
  assert.equal(rowCount(reopened.database.connection, "users"), 2);
  assert.equal(rowCount(reopened.database.connection, "channel_endpoints"), 3);
  reopened.close();
});

test("removed publication is disabled and endpoint tuple reassignment is rejected atomically", () => {
  const setup = fixture();
  const original = bootstrapFoundation(setup.config(), { now: () => 1_000 });
  original.close();

  const users = setup.raw.users as Array<Record<string, unknown>>;
  setup.raw.users = [users[0]];
  const reduced = bootstrapFoundation(setup.config(), { now: () => 2_000 });
  assert.equal(rowCount(reduced.database.connection, "users", 1), 1);
  assert.equal(
    rowCount(reduced.database.connection, "channel_endpoints", 1),
    2,
  );
  reduced.close();

  const alice = users[0];
  const bob = users[1];
  assert.ok(alice !== undefined && bob !== undefined);
  setup.raw.users = [{ ...bob, telegram: alice.telegram }];
  assert.throws(
    () => bootstrapFoundation(setup.config(), { now: () => 3_000 }),
    /cannot be reassigned/u,
  );

  const afterFailure = openFoundationDatabase(setup.dataRoot);
  assert.equal(rowCount(afterFailure.connection, "users", 1), 1);
  assert.equal(rowCount(afterFailure.connection, "channel_endpoints", 1), 2);
  afterFailure.close();
});

test("workspace inode drift is rejected on restart", () => {
  const setup = fixture();
  const original = bootstrapFoundation(setup.config());
  original.close();
  renameSync(setup.aliceWorkspace, `${setup.aliceWorkspace}-old`);
  privateDirectory(setup.aliceWorkspace);
  assert.throws(
    () => bootstrapFoundation(setup.config()),
    /workspace identity changed/u,
  );
});

test("unsafe directory permissions, overlaps, and low free space fail before database startup", () => {
  const permissions = fixture();
  chmodSync(permissions.aliceWorkspace, 0o755);
  assert.throws(
    () => validateTopology(permissions.config()),
    /group or other/u,
  );

  const overlap = fixture();
  overlap.raw.dataRoot = join(overlap.aliceWorkspace, "data");
  assert.throws(() => validateTopology(overlap.config()), /nested or overlap/u);

  const lowSpace = fixture();
  lowSpace.raw.minimumFreeBytes = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => validateTopology(lowSpace.config()),
    /free-space threshold/u,
  );

  const symlink = fixture();
  const linkedWorkspace = join(symlink.root, "linked-workspace");
  symlinkSync(symlink.aliceWorkspace, linkedWorkspace);
  const symlinkUsers = symlink.raw.users as Array<Record<string, unknown>>;
  const symlinkAlice = symlinkUsers[0];
  assert.ok(symlinkAlice !== undefined);
  symlinkAlice.workspace = linkedWorkspace;
  assert.throws(() => validateTopology(symlink.config()), /symbolic link/u);
});

test("unknown schema versions and table sets are rejected", () => {
  const setup = fixture();
  privateDirectory(setup.dataRoot);
  const path = join(setup.dataRoot, "hitch.sqlite");
  writeFileSync(path, "", { mode: 0o600 });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  assert.throws(
    () => openFoundationDatabase(setup.dataRoot),
    /unsupported database schema/u,
  );

  const missingTables = fixture();
  privateDirectory(missingTables.dataRoot);
  const missingTablesPath = join(missingTables.dataRoot, "hitch.sqlite");
  writeFileSync(missingTablesPath, "", { mode: 0o600 });
  const incomplete = new DatabaseSync(missingTablesPath);
  incomplete.exec(
    "CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;" +
      "INSERT INTO app_meta(key, value) VALUES ('schema_id', 'hitch-pi-mvp-schema-1');" +
      "PRAGMA user_version = 1;",
  );
  incomplete.close();
  assert.throws(
    () => openFoundationDatabase(missingTables.dataRoot),
    /table set is unknown/u,
  );
});

test("database composite foreign keys prevent cross-owner state links", () => {
  const setup = fixture();
  const foundation = bootstrapFoundation(setup.config(), { now: () => 1_000 });
  const database = foundation.database.connection;
  database
    .prepare(
      `INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run("session-alice", "alice", "main", "pi-alice", 1, 1);
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run("session-alice-duplicate", "alice", "other", "pi-alice", 1, 1),
    /UNIQUE constraint failed/u,
  );
  database
    .prepare(
      `INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run("session-bob", "bob", "main", "pi-bob", 1, 1);
  database
    .prepare("UPDATE sessions SET transcript_path = ? WHERE id = ?")
    .run("/private/alice.jsonl", "session-alice");
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO sessions(
             id, user_id, name, pi_session_id, transcript_path, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          "session-bob-shared",
          "bob",
          "other",
          "pi-bob-other",
          "/private/alice.jsonl",
          1,
          1,
        ),
    /UNIQUE constraint failed/u,
  );
  const aliceEndpoints = database
    .prepare("SELECT id FROM channel_endpoints WHERE user_id = ? ORDER BY id")
    .all("alice") as Array<{ id: string }>;
  const aliceEndpoint = aliceEndpoints[0];
  const aliceOtherEndpoint = aliceEndpoints[1];
  assert.ok(aliceEndpoint !== undefined && aliceOtherEndpoint !== undefined);
  const bobEndpoint = database
    .prepare("SELECT id FROM channel_endpoints WHERE user_id = ? LIMIT 1")
    .get("bob") as {
    id: string;
  };
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE channel_endpoints SET selected_session_id = ? WHERE id = ?",
        )
        .run("session-alice", bobEndpoint.id),
    /FOREIGN KEY constraint failed/u,
  );

  const insertTurn = database.prepare(
    `INSERT INTO turns(
       id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
       prompt_text, ordinal, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  );
  assert.throws(
    () =>
      insertTurn.run(
        "turn-cross-endpoint",
        "alice",
        "session-alice",
        bobEndpoint.id,
        "message-1",
        "digest-1",
        "prompt",
        1,
        1,
        1,
      ),
    /FOREIGN KEY constraint failed/u,
  );
  assert.throws(
    () =>
      insertTurn.run(
        "turn-cross-session",
        "bob",
        "session-alice",
        bobEndpoint.id,
        "message-2",
        "digest-2",
        "prompt",
        1,
        1,
        1,
      ),
    /FOREIGN KEY constraint failed/u,
  );
  insertTurn.run(
    "turn-alice",
    "alice",
    "session-alice",
    aliceEndpoint.id,
    "message-3",
    "digest-3",
    "prompt",
    1,
    1,
    1,
  );

  const insertOutbox = database.prepare(
    `INSERT INTO outbox(
       id, user_id, endpoint_id, turn_id, kind, payload_text, state,
       attempts, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'text', ?, 'pending', 0, ?, ?)`,
  );
  assert.throws(
    () =>
      insertOutbox.run(
        "outbox-cross-turn",
        "bob",
        bobEndpoint.id,
        "turn-alice",
        "result",
        1,
        1,
      ),
    /FOREIGN KEY constraint failed/u,
  );
  assert.throws(
    () =>
      insertOutbox.run(
        "outbox-cross-endpoint",
        "alice",
        bobEndpoint.id,
        null,
        "result",
        1,
        1,
      ),
    /FOREIGN KEY constraint failed/u,
  );
  assert.throws(
    () =>
      insertOutbox.run(
        "outbox-wrong-origin",
        "alice",
        aliceOtherEndpoint.id,
        "turn-alice",
        "result",
        1,
        1,
      ),
    /FOREIGN KEY constraint failed/u,
  );
  foundation.close();
});

test("non-private database files are rejected", () => {
  const setup = fixture();
  privateDirectory(setup.dataRoot);
  const databasePath = join(setup.dataRoot, "hitch.sqlite");
  writeFileSync(databasePath, "", { mode: 0o644 });
  chmodSync(databasePath, 0o644);
  assert.throws(() => openFoundationDatabase(setup.dataRoot), FoundationError);
});
