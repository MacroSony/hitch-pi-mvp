import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FoundationError,
  type PublishedEndpoint,
  type ValidatedTopology,
} from "./filesystem.js";

const SCHEMA_VERSION = 6;
const SCHEMA_ID = "hitch-pi-mvp-schema-5";
const EXPECTED_TABLES = [
  "app_meta",
  "artifacts",
  "channel_endpoints",
  "outbox",
  "sessions",
  "staged_artifacts",
  "turn_artifacts",
  "turns",
  "users",
];
const SCHEMA_1_TABLES = [
  "app_meta",
  "channel_endpoints",
  "outbox",
  "sessions",
  "turns",
  "users",
];

const SCHEMA = `
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL UNIQUE,
  workspace_device TEXT NOT NULL,
  workspace_inode TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_device, workspace_inode)
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  pi_session_id TEXT NOT NULL,
  transcript_path TEXT,
  model_provider TEXT,
  model_id TEXT,
  thinking_level TEXT,
  forge_kind TEXT CHECK (forge_kind IN ('preset', 'profile')),
  forge_id TEXT CHECK (
    (forge_kind IS NULL AND forge_id IS NULL) OR
    (forge_kind IS NOT NULL AND forge_id IS NOT NULL AND length(CAST(forge_id AS BLOB)) BETWEEN 1 AND 64)
  ),
  state TEXT NOT NULL CHECK (state IN ('active', 'stopped', 'quarantined')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name),
  UNIQUE (user_id, pi_session_id),
  UNIQUE (transcript_path),
  UNIQUE (id, user_id)
) STRICT;

CREATE TABLE channel_endpoints (
  id TEXT PRIMARY KEY,
  tuple_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'wechat', 'wecom')),
  account_id TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  private_chat_id TEXT,
  selected_session_id TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, user_id),
  FOREIGN KEY (selected_session_id, user_id) REFERENCES sessions(id, user_id),
  CHECK (
    (kind = 'telegram' AND private_chat_id IS NOT NULL) OR
    (kind IN ('wechat', 'wecom') AND private_chat_id IS NULL)
  )
) STRICT;

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  operation_kind TEXT NOT NULL DEFAULT 'prompt' CHECK (operation_kind IN ('prompt', 'publish', 'compact')),
  publish_path TEXT,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'terminal')),
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'timed-out', 'unknown')),
  result_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (endpoint_id, idempotency_key),
  UNIQUE (user_id, ordinal),
  UNIQUE (id, user_id),
  UNIQUE (id, endpoint_id, user_id),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id),
  FOREIGN KEY (endpoint_id, user_id) REFERENCES channel_endpoints(id, user_id),
  CHECK (
    (operation_kind = 'prompt' AND publish_path IS NULL) OR
    (operation_kind = 'publish' AND publish_path IS NOT NULL) OR
    (operation_kind = 'compact' AND publish_path IS NULL)
  )
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK (bytes >= 0 AND bytes <= 52428800),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'file')),
  mime_type TEXT NOT NULL CHECK (length(CAST(mime_type AS BLOB)) BETWEEN 1 AND 127),
  display_name TEXT NOT NULL CHECK (length(CAST(display_name AS BLOB)) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL,
  UNIQUE (id, user_id)
) STRICT;

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint_id TEXT NOT NULL,
  turn_id TEXT,
  artifact_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'artifact')),
  payload_text TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'retryable', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id, user_id) REFERENCES channel_endpoints(id, user_id),
  FOREIGN KEY (turn_id, endpoint_id, user_id) REFERENCES turns(id, endpoint_id, user_id),
  FOREIGN KEY (artifact_id, user_id) REFERENCES artifacts(id, user_id),
  CHECK (
    (kind = 'text' AND payload_text IS NOT NULL AND artifact_id IS NULL) OR
    (kind = 'artifact' AND artifact_id IS NOT NULL AND payload_text IS NULL)
  )
) STRICT;

CREATE TABLE turn_artifacts (
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 8),
  PRIMARY KEY (turn_id, direction, ordinal),
  UNIQUE (turn_id, artifact_id),
  FOREIGN KEY (turn_id, user_id) REFERENCES turns(id, user_id),
  FOREIGN KEY (artifact_id, user_id) REFERENCES artifacts(id, user_id)
) STRICT;

CREATE TABLE staged_artifacts (
  user_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 8),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ordinal),
  UNIQUE (artifact_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (artifact_id, user_id) REFERENCES artifacts(id, user_id)
) STRICT;

CREATE INDEX turns_user_state_ordinal ON turns(user_id, state, ordinal);
CREATE INDEX outbox_endpoint_state ON outbox(endpoint_id, state, created_at);
CREATE INDEX artifacts_user_created ON artifacts(user_id, created_at);
CREATE INDEX staged_artifacts_user_created ON staged_artifacts(user_id, created_at);
`;

const MIGRATE_2_TO_3 = `
CREATE TABLE staged_artifacts (
  user_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 8),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ordinal),
  UNIQUE (artifact_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (artifact_id, user_id) REFERENCES artifacts(id, user_id)
) STRICT;
CREATE INDEX staged_artifacts_user_created ON staged_artifacts(user_id, created_at);
`;

const MIGRATE_3_TO_4 = `
ALTER TABLE sessions ADD COLUMN forge_kind TEXT CHECK (forge_kind IN ('preset', 'profile'));
ALTER TABLE sessions ADD COLUMN forge_id TEXT CHECK (
  (forge_kind IS NULL AND forge_id IS NULL) OR
  (forge_kind IS NOT NULL AND forge_id IS NOT NULL AND length(CAST(forge_id AS BLOB)) BETWEEN 1 AND 64)
);
`;

const MIGRATE_4_TO_5 = `
CREATE TABLE channel_endpoints_new (
  id TEXT PRIMARY KEY,
  tuple_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'wechat', 'wecom')),
  account_id TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  private_chat_id TEXT,
  selected_session_id TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, user_id),
  FOREIGN KEY (selected_session_id, user_id) REFERENCES sessions(id, user_id),
  CHECK (
    (kind = 'telegram' AND private_chat_id IS NOT NULL) OR
    (kind IN ('wechat', 'wecom') AND private_chat_id IS NULL)
  )
) STRICT;
INSERT INTO channel_endpoints_new(
  id, tuple_key, user_id, kind, account_id, platform_user_id, private_chat_id,
  selected_session_id, enabled, published_at, updated_at
)
SELECT id, tuple_key, user_id, kind, account_id, platform_user_id, private_chat_id,
       selected_session_id, enabled, published_at, updated_at
FROM channel_endpoints;
DROP TABLE channel_endpoints;
ALTER TABLE channel_endpoints_new RENAME TO channel_endpoints;
`;

const MIGRATE_5_TO_6 = `
CREATE TABLE turns_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  operation_kind TEXT NOT NULL DEFAULT 'prompt' CHECK (operation_kind IN ('prompt', 'publish', 'compact')),
  publish_path TEXT,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'terminal')),
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'timed-out', 'unknown')),
  result_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (endpoint_id, idempotency_key),
  UNIQUE (user_id, ordinal),
  UNIQUE (id, user_id),
  UNIQUE (id, endpoint_id, user_id),
  FOREIGN KEY (session_id, user_id) REFERENCES sessions(id, user_id),
  FOREIGN KEY (endpoint_id, user_id) REFERENCES channel_endpoints(id, user_id),
  CHECK (
    (operation_kind = 'prompt' AND publish_path IS NULL) OR
    (operation_kind = 'publish' AND publish_path IS NOT NULL) OR
    (operation_kind = 'compact' AND publish_path IS NULL)
  )
) STRICT;
INSERT INTO turns_new(
  id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
  prompt_text, operation_kind, publish_path, ordinal, state, outcome,
  result_text, created_at, updated_at
)
SELECT id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
       prompt_text, operation_kind, publish_path, ordinal, state, outcome,
       result_text, created_at, updated_at
FROM turns;
DROP TABLE turns;
ALTER TABLE turns_new RENAME TO turns;
`;

const MIGRATE_1_TO_2 = `
ALTER TABLE turns ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'prompt'
  CHECK (operation_kind IN ('prompt', 'publish'));
ALTER TABLE turns ADD COLUMN publish_path TEXT
  CHECK ((operation_kind = 'prompt' AND publish_path IS NULL) OR
         (operation_kind = 'publish' AND publish_path IS NOT NULL));

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK (bytes >= 0 AND bytes <= 52428800),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'file')),
  mime_type TEXT NOT NULL CHECK (length(CAST(mime_type AS BLOB)) BETWEEN 1 AND 127),
  display_name TEXT NOT NULL CHECK (length(CAST(display_name AS BLOB)) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL,
  UNIQUE (id, user_id)
) STRICT;

CREATE TABLE turn_artifacts (
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 8),
  PRIMARY KEY (turn_id, direction, ordinal),
  UNIQUE (turn_id, artifact_id),
  FOREIGN KEY (turn_id, user_id) REFERENCES turns(id, user_id),
  FOREIGN KEY (artifact_id, user_id) REFERENCES artifacts(id, user_id)
) STRICT;

DROP INDEX outbox_endpoint_state;
ALTER TABLE outbox RENAME TO outbox_schema_1;
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint_id TEXT NOT NULL,
  turn_id TEXT,
  artifact_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'artifact')),
  payload_text TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'retryable', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id, user_id) REFERENCES channel_endpoints(id, user_id),
  FOREIGN KEY (turn_id, endpoint_id, user_id) REFERENCES turns(id, endpoint_id, user_id),
  FOREIGN KEY (artifact_id, user_id) REFERENCES artifacts(id, user_id),
  CHECK (
    (kind = 'text' AND payload_text IS NOT NULL AND artifact_id IS NULL) OR
    (kind = 'artifact' AND artifact_id IS NOT NULL AND payload_text IS NULL)
  )
) STRICT;
INSERT INTO outbox(
  id, user_id, endpoint_id, turn_id, artifact_id, kind, payload_text,
  state, attempts, created_at, updated_at
)
SELECT id, user_id, endpoint_id, turn_id, NULL, kind, payload_text,
       state, attempts, created_at, updated_at
FROM outbox_schema_1;
DROP TABLE outbox_schema_1;
CREATE INDEX outbox_endpoint_state ON outbox(endpoint_id, state, created_at);
CREATE INDEX artifacts_user_created ON artifacts(user_id, created_at);
`;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface FoundationDatabase {
  readonly path: string;
  readonly connection: DatabaseSync;
  close(): void;
}

function withPrivateUmask<T>(operation: () => T): T {
  const previous = process.umask(0o077);
  try {
    return operation();
  } finally {
    process.umask(previous);
  }
}

function ensurePrivateDatabaseFile(path: string): void {
  const existing = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (existing === undefined) {
    closeSync(openSync(path, "wx", 0o600));
  } else if (
    !existing.isFile() ||
    existing.isSymbolicLink() ||
    existing.nlink !== 1n
  ) {
    throw new FoundationError(
      "database path must be a regular single-link file",
    );
  }
  const metadata = lstatSync(path, { bigint: true });
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== BigInt(currentUid)) {
    throw new FoundationError(
      "database file must be owned by the service user",
    );
  }
  if ((metadata.mode & 0o077n) !== 0n)
    throw new FoundationError("database file must be private");
  if (realpathSync(path) !== path)
    throw new FoundationError("database path must be canonical");
}

function scalarNumber(value: unknown, label: string): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw new FoundationError(`database returned an invalid ${label}`);
}

function tableNames(connection: DatabaseSync): unknown[] {
  return connection
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((entry) => (entry as { name: unknown }).name);
}

function verifySchema(connection: DatabaseSync): void {
  const row = connection.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  const version = scalarNumber(row?.user_version, "schema version");
  if (version === 0) {
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(SCHEMA);
      connection
        .prepare("INSERT INTO app_meta(key, value) VALUES (?, ?)")
        .run("schema_id", SCHEMA_ID);
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  } else if (version === 1) {
    connection.exec("PRAGMA foreign_keys = OFF");
    connection.exec("BEGIN IMMEDIATE");
    try {
      const meta = connection
        .prepare("SELECT value FROM app_meta WHERE key = ?")
        .get("schema_id") as { value?: unknown } | undefined;
      if (meta?.value !== "hitch-pi-mvp-schema-1")
        throw new FoundationError("database schema 1 identity is unknown");
      if (
        JSON.stringify(tableNames(connection)) !==
        JSON.stringify(SCHEMA_1_TABLES)
      )
        throw new FoundationError("database table set is unknown");
      connection.exec(MIGRATE_1_TO_2);
      connection.exec(MIGRATE_2_TO_3);
      connection.exec(MIGRATE_3_TO_4);
      connection.exec(MIGRATE_4_TO_5);
      connection.exec(MIGRATE_5_TO_6);
      connection
        .prepare("UPDATE app_meta SET value = ? WHERE key = ?")
        .run(SCHEMA_ID, "schema_id");
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      connection.exec("COMMIT");
      const violations = connection
        .prepare("PRAGMA foreign_key_check")
        .all() as unknown[];
      if (violations.length > 0)
        throw new FoundationError("database schema 6 foreign key check failed");
    } catch (error) {
      connection.exec("ROLLBACK");
      connection.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    connection.exec("PRAGMA foreign_keys = ON");
  } else if (version === 2) {
    connection.exec("PRAGMA foreign_keys = OFF");
    connection.exec("BEGIN IMMEDIATE");
    try {
      const meta = connection
        .prepare("SELECT value FROM app_meta WHERE key = ?")
        .get("schema_id") as { value?: unknown } | undefined;
      if (meta?.value !== "hitch-pi-mvp-schema-2")
        throw new FoundationError("database schema 2 identity is unknown");
      connection.exec(MIGRATE_2_TO_3);
      connection.exec(MIGRATE_3_TO_4);
      connection.exec(MIGRATE_4_TO_5);
      connection.exec(MIGRATE_5_TO_6);
      connection
        .prepare("UPDATE app_meta SET value = ? WHERE key = ?")
        .run(SCHEMA_ID, "schema_id");
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      connection.exec("COMMIT");
      const violations = connection
        .prepare("PRAGMA foreign_key_check")
        .all() as unknown[];
      if (violations.length > 0)
        throw new FoundationError("database schema 6 foreign key check failed");
    } catch (error) {
      connection.exec("ROLLBACK");
      connection.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    connection.exec("PRAGMA foreign_keys = ON");
  } else if (version === 3) {
    connection.exec("PRAGMA foreign_keys = OFF");
    connection.exec("BEGIN IMMEDIATE");
    try {
      const meta = connection
        .prepare("SELECT value FROM app_meta WHERE key = ?")
        .get("schema_id") as { value?: unknown } | undefined;
      if (meta?.value !== "hitch-pi-mvp-schema-3")
        throw new FoundationError("database schema 3 identity is unknown");
      connection.exec(MIGRATE_3_TO_4);
      connection.exec(MIGRATE_4_TO_5);
      connection.exec(MIGRATE_5_TO_6);
      connection
        .prepare("UPDATE app_meta SET value = ? WHERE key = ?")
        .run(SCHEMA_ID, "schema_id");
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  } else if (version === 4) {
    connection.exec("PRAGMA foreign_keys = OFF");
    connection.exec("BEGIN IMMEDIATE");
    try {
      const meta = connection
        .prepare("SELECT value FROM app_meta WHERE key = ?")
        .get("schema_id") as { value?: unknown } | undefined;
      if (meta?.value !== "hitch-pi-mvp-schema-4")
        throw new FoundationError("database schema 4 identity is unknown");
      connection.exec(MIGRATE_4_TO_5);
      connection.exec(MIGRATE_5_TO_6);
      connection
        .prepare("UPDATE app_meta SET value = ? WHERE key = ?")
        .run(SCHEMA_ID, "schema_id");
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      connection.exec("COMMIT");
      const violations = connection
        .prepare("PRAGMA foreign_key_check")
        .all() as unknown[];
      if (violations.length > 0)
        throw new FoundationError("database schema 6 foreign key check failed");
    } catch (error) {
      connection.exec("ROLLBACK");
      connection.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    connection.exec("PRAGMA foreign_keys = ON");
  } else if (version === 5) {
    connection.exec("PRAGMA foreign_keys = OFF");
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection.exec(MIGRATE_5_TO_6);
      connection
        .prepare("UPDATE app_meta SET value = ? WHERE key = ?")
        .run(SCHEMA_ID, "schema_id");
      connection.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      connection.exec("COMMIT");
      const violations = connection
        .prepare("PRAGMA foreign_key_check")
        .all() as unknown[];
      if (violations.length > 0)
        throw new FoundationError("database schema 6 foreign key check failed");
    } catch (error) {
      connection.exec("ROLLBACK");
      connection.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    connection.exec("PRAGMA foreign_keys = ON");
  } else if (version !== SCHEMA_VERSION) {
    throw new FoundationError(
      `unsupported database schema version: ${version}`,
    );
  }

  const meta = connection
    .prepare("SELECT value FROM app_meta WHERE key = ?")
    .get("schema_id") as { value?: unknown } | undefined;
  if (meta?.value !== SCHEMA_ID)
    throw new FoundationError("database schema identity is missing or unknown");
  const tables = tableNames(connection);
  if (JSON.stringify(tables) !== JSON.stringify(EXPECTED_TABLES)) {
    throw new FoundationError("database table set is unknown");
  }
  const integrity = connection.prepare("PRAGMA quick_check").get() as
    | { quick_check?: unknown }
    | undefined;
  if (integrity?.quick_check !== "ok")
    throw new FoundationError("database integrity check failed");
}

export function openFoundationDatabase(dataRoot: string): FoundationDatabase {
  const path = join(dataRoot, "hitch.sqlite");
  ensurePrivateDatabaseFile(path);
  const connection = withPrivateUmask(
    () =>
      new DatabaseSync(path, {
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
        timeout: 5_000,
        readBigInts: true,
      }),
  );
  try {
    withPrivateUmask(() =>
      connection.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;",
      ),
    );
    verifySchema(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
  return { path, connection, close: () => connection.close() };
}

function endpointId(endpoint: PublishedEndpoint): string {
  return `endpoint_${createHash("sha256").update(endpoint.tupleKey).digest("hex").slice(0, 24)}`;
}

function transaction<T>(connection: DatabaseSync, operation: () => T): T {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}

export function publishStaticTopology(
  foundation: FoundationDatabase,
  topology: ValidatedTopology,
  clock: Clock = systemClock,
): void {
  transaction(foundation.connection, () => {
    const now = clock.now();
    foundation.connection
      .prepare("UPDATE channel_endpoints SET enabled = 0, updated_at = ?")
      .run(now);
    foundation.connection
      .prepare("UPDATE users SET enabled = 0, updated_at = ?")
      .run(now);

    const findUser = foundation.connection.prepare(
      "SELECT workspace_path, workspace_device, workspace_inode FROM users WHERE id = ?",
    );
    const insertUser = foundation.connection.prepare(
      `INSERT INTO users(id, workspace_path, workspace_device, workspace_inode, enabled, published_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    );
    const enableUser = foundation.connection.prepare(
      "UPDATE users SET enabled = 1, updated_at = ? WHERE id = ?",
    );
    const findEndpoint = foundation.connection.prepare(
      "SELECT user_id, kind, account_id, platform_user_id, private_chat_id FROM channel_endpoints WHERE tuple_key = ?",
    );
    const insertEndpoint = foundation.connection.prepare(
      `INSERT INTO channel_endpoints(
         id, tuple_key, user_id, kind, account_id, platform_user_id, private_chat_id,
         selected_session_id, enabled, published_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    );
    const enableEndpoint = foundation.connection.prepare(
      "UPDATE channel_endpoints SET enabled = 1, updated_at = ? WHERE tuple_key = ?",
    );

    for (const user of topology.users) {
      const existingUser = findUser.get(user.id) as
        | {
            workspace_path: unknown;
            workspace_device: unknown;
            workspace_inode: unknown;
          }
        | undefined;
      if (existingUser === undefined) {
        insertUser.run(
          user.id,
          user.workspace.path,
          user.workspace.device,
          user.workspace.inode,
          now,
          now,
        );
      } else {
        if (
          existingUser.workspace_path !== user.workspace.path ||
          existingUser.workspace_device !== user.workspace.device ||
          existingUser.workspace_inode !== user.workspace.inode
        ) {
          throw new FoundationError(
            `published workspace identity changed for user ${user.id}`,
          );
        }
        enableUser.run(now, user.id);
      }

      for (const endpoint of user.endpoints) {
        const existingEndpoint = findEndpoint.get(endpoint.tupleKey) as
          | {
              user_id: unknown;
              kind: unknown;
              account_id: unknown;
              platform_user_id: unknown;
              private_chat_id: unknown;
            }
          | undefined;
        if (existingEndpoint === undefined) {
          insertEndpoint.run(
            endpointId(endpoint),
            endpoint.tupleKey,
            user.id,
            endpoint.kind,
            endpoint.accountId,
            endpoint.platformUserId,
            endpoint.privateChatId,
            now,
            now,
          );
        } else {
          if (
            existingEndpoint.user_id !== user.id ||
            existingEndpoint.kind !== endpoint.kind ||
            existingEndpoint.account_id !== endpoint.accountId ||
            existingEndpoint.platform_user_id !== endpoint.platformUserId ||
            existingEndpoint.private_chat_id !== endpoint.privateChatId
          ) {
            throw new FoundationError(
              "published endpoint tuple cannot be reassigned or changed",
            );
          }
          enableEndpoint.run(now, endpoint.tupleKey);
        }
      }
    }
  });
}
