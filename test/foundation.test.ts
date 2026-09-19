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
  database
    .prepare(
      `INSERT INTO artifacts(
         id, user_id, storage_key, sha256, bytes, media_kind, mime_type,
         display_name, created_at
       ) VALUES (?, ?, ?, ?, ?, 'file', 'text/plain', 'note.txt', ?)`,
    )
    .run("artifact-bob", "bob", "bob/object.blob", "0".repeat(64), 4, 1);
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO turn_artifacts(turn_id, user_id, artifact_id, direction, ordinal)
           VALUES ('turn-alice', 'alice', 'artifact-bob', 'inbound', 0)`,
        )
        .run(),
    /FOREIGN KEY constraint failed/u,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO outbox(
             id, user_id, endpoint_id, turn_id, artifact_id, kind, payload_text,
             state, attempts, created_at, updated_at
           ) VALUES ('outbox-cross-artifact', 'alice', ?, 'turn-alice',
                     'artifact-bob', 'artifact', NULL, 'pending', 0, 1, 1)`,
        )
        .run(aliceEndpoint.id),
    /FOREIGN KEY constraint failed/u,
  );
  foundation.close();
});

test("schema 1 state migrates to current schema without losing Turns or outbox", () => {
  const setup = fixture();
  privateDirectory(setup.dataRoot);
  const path = join(setup.dataRoot, "hitch.sqlite");
  writeFileSync(path, "", { mode: 0o600 });
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL UNIQUE,
      workspace_device TEXT NOT NULL, workspace_inode TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      published_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (workspace_device, workspace_inode)
    ) STRICT;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, pi_session_id TEXT NOT NULL, transcript_path TEXT,
      model_provider TEXT, model_id TEXT, thinking_level TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'stopped', 'quarantined')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (user_id, name), UNIQUE (user_id, pi_session_id),
      UNIQUE (transcript_path), UNIQUE (id, user_id)
    ) STRICT;
    CREATE TABLE channel_endpoints (
      id TEXT PRIMARY KEY, tuple_key TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('telegram', 'wechat')),
      account_id TEXT NOT NULL, platform_user_id TEXT NOT NULL,
      private_chat_id TEXT, selected_session_id TEXT,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      published_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (id, user_id),
      FOREIGN KEY (selected_session_id, user_id) REFERENCES sessions(id, user_id),
      CHECK ((kind = 'telegram' AND private_chat_id IS NOT NULL) OR
             (kind = 'wechat' AND private_chat_id IS NULL))
    ) STRICT;
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      session_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, content_digest TEXT NOT NULL,
      prompt_text TEXT NOT NULL, ordinal INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'terminal')),
      outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'timed-out', 'unknown')),
      result_text TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (endpoint_id, idempotency_key), UNIQUE (user_id, ordinal),
      UNIQUE (id, user_id), UNIQUE (id, endpoint_id, user_id),
      FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id),
      FOREIGN KEY (endpoint_id, user_id) REFERENCES channel_endpoints(id, user_id)
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      endpoint_id TEXT NOT NULL, turn_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'artifact')), payload_text TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'retryable', 'failed', 'expired')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (endpoint_id, user_id) REFERENCES channel_endpoints(id, user_id),
      FOREIGN KEY (turn_id, endpoint_id, user_id) REFERENCES turns(id, endpoint_id, user_id)
    ) STRICT;
    CREATE INDEX turns_user_state_ordinal ON turns(user_id, state, ordinal);
    CREATE INDEX outbox_endpoint_state ON outbox(endpoint_id, state, created_at);
    INSERT INTO app_meta VALUES ('schema_id', 'hitch-pi-mvp-schema-1');
    INSERT INTO users VALUES ('alice', '/workspace', '1', '2', 1, 1, 1);
    INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at)
      VALUES ('session', 'alice', 'main', 'pi', 'active', 1, 1);
    INSERT INTO channel_endpoints(
      id, tuple_key, user_id, kind, account_id, platform_user_id,
      private_chat_id, selected_session_id, enabled, published_at, updated_at
    ) VALUES ('endpoint', 'tuple', 'alice', 'telegram', 'primary', '101',
              '101', 'session', 1, 1, 1);
    INSERT INTO turns(
      id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
      prompt_text, ordinal, state, outcome, result_text, created_at, updated_at
    ) VALUES ('turn', 'alice', 'session', 'endpoint', 'message', 'digest',
              'hello', 1, 'terminal', 'succeeded', 'world', 1, 1);
    INSERT INTO outbox VALUES (
      'outbox', 'alice', 'endpoint', 'turn', 'text', 'world', 'pending', 0, 1, 1
    );
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const migrated = openFoundationDatabase(setup.dataRoot);
  const version = migrated.connection.prepare("PRAGMA user_version").get() as {
    user_version: bigint;
  };
  assert.equal(version.user_version, 8n);
  // The v7 turns CHECK must accept compact Turns after migration.
  const probeIds = migrated.connection
    .prepare(
      "SELECT id, user_id FROM channel_endpoints WHERE kind = 'telegram' LIMIT 1",
    )
    .get() as { id: string; user_id: string };
  migrated.connection
    .prepare(
      "INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at) VALUES ('session-compact-probe', ?, 'probe', 'pi-probe', 'active', 1, 1)",
    )
    .run(probeIds.user_id);
  migrated.connection
    .prepare(
      `INSERT INTO turns(
         id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
         prompt_text, operation_kind, ordinal, state, created_at, updated_at
       ) VALUES ('turn-compact-probe', ?, 'session-compact-probe', ?, 'probe', 'probe', '!compact', 'compact', 99, 'queued', 1, 1)`,
    )
    .run(probeIds.user_id, probeIds.id);
  const staged = migrated.connection
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'staged_artifacts'",
    )
    .get() as { name: string } | undefined;
  assert.equal(staged?.name, "staged_artifacts");
  const sessionColumns = migrated.connection
    .prepare("SELECT forge_kind, forge_id FROM sessions WHERE id = 'session'")
    .get() as { forge_kind: string | null; forge_id: string | null };
  assert.deepEqual({ ...sessionColumns }, { forge_kind: null, forge_id: null });
  const turn = migrated.connection
    .prepare("SELECT operation_kind, publish_path FROM turns WHERE id = 'turn'")
    .get() as { operation_kind: string; publish_path: string | null };
  assert.deepEqual(
    { ...turn },
    { operation_kind: "prompt", publish_path: null },
  );
  const outbox = migrated.connection
    .prepare(
      "SELECT kind, payload_text, artifact_id FROM outbox WHERE id = 'outbox'",
    )
    .get() as {
    kind: string;
    payload_text: string;
    artifact_id: string | null;
  };
  assert.deepEqual(
    { ...outbox },
    { kind: "text", payload_text: "world", artifact_id: null },
  );
  assert.equal(rowCount(migrated.connection, "artifacts"), 0);
  assert.equal(rowCount(migrated.connection, "turn_artifacts"), 0);
  migrated.close();
});

test("non-private database files are rejected", () => {
  const setup = fixture();
  privateDirectory(setup.dataRoot);
  const databasePath = join(setup.dataRoot, "hitch.sqlite");
  writeFileSync(databasePath, "", { mode: 0o644 });
  chmodSync(databasePath, 0o644);
  assert.throws(() => openFoundationDatabase(setup.dataRoot), FoundationError);
});

test("schema 6 migrates context snapshot column without changing existing rows", () => {
  const setup = fixture();
  const initial = bootstrapFoundation(setup.config());
  const userCount = rowCount(initial.database.connection, "users");
  initial.database.connection.exec(
    "DROP TABLE local_requests; ALTER TABLE sessions DROP COLUMN context_usage; UPDATE app_meta SET value='hitch-pi-mvp-schema-5' WHERE key='schema_id'; PRAGMA user_version=6;",
  );
  initial.close();
  const migrated = openFoundationDatabase(setup.dataRoot);
  try {
    assert.equal(
      (
        migrated.connection.prepare("PRAGMA user_version").get() as {
          user_version: bigint;
        }
      ).user_version,
      8n,
    );
    assert.equal(rowCount(migrated.connection, "users"), userCount);
    assert.equal(
      (
        migrated.connection
          .prepare("SELECT value FROM app_meta WHERE key='schema_id'")
          .get() as { value: string }
      ).value,
      "hitch-pi-mvp-schema-8",
    );
    assert.deepEqual(
      migrated.connection.prepare("PRAGMA foreign_key_check").all(),
      [],
    );
    assert.ok(
      migrated.connection
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .some((row) => row.name === "context_usage"),
    );
  } finally {
    migrated.close();
  }
});

test("schema 6 with unknown identity is rejected before migration", () => {
  const setup = fixture();
  const initial = bootstrapFoundation(setup.config());
  initial.database.connection.exec(
    "DROP TABLE local_requests; ALTER TABLE sessions DROP COLUMN context_usage; UPDATE app_meta SET value='unknown-schema' WHERE key='schema_id'; PRAGMA user_version=6;",
  );
  initial.close();
  assert.throws(
    () => openFoundationDatabase(setup.dataRoot),
    /schema 6 identity is unknown/u,
  );
});

test("actual-like schema 7 migrates local receipts and repairs the FIFO index", () => {
  const setup = fixture();
  const initial = bootstrapFoundation(setup.config());
  initial.database.connection.exec(
    "DROP TABLE local_requests; DROP INDEX turns_user_state_ordinal; UPDATE app_meta SET value='hitch-pi-mvp-schema-7' WHERE key='schema_id'; PRAGMA user_version=7;",
  );
  initial.close();
  const migrated = openFoundationDatabase(setup.dataRoot);
  try {
    assert.equal(
      (
        migrated.connection.prepare("PRAGMA user_version").get() as {
          user_version: bigint;
        }
      ).user_version,
      8n,
    );
    assert.ok(
      migrated.connection
        .prepare("PRAGMA index_list(turns)")
        .all()
        .some((row) => row.name === "turns_user_state_ordinal"),
    );
    assert.equal(rowCount(migrated.connection, "local_requests"), 0);
    assert.deepEqual(
      migrated.connection.prepare("PRAGMA foreign_key_check").all(),
      [],
    );
  } finally {
    migrated.close();
  }
});
