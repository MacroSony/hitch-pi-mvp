import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FoundationError,
  type PublishedEndpoint,
  type ValidatedTopology,
} from "./filesystem.js";

const SCHEMA_VERSION = 1;
const SCHEMA_ID = "hitch-pi-mvp-schema-1";
const EXPECTED_TABLES = [
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
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'wechat')),
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
    (kind = 'wechat' AND private_chat_id IS NULL)
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
  FOREIGN KEY (endpoint_id, user_id) REFERENCES channel_endpoints(id, user_id)
) STRICT;

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint_id TEXT NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'artifact')),
  payload_text TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'retryable', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id, user_id) REFERENCES channel_endpoints(id, user_id),
  FOREIGN KEY (turn_id, endpoint_id, user_id) REFERENCES turns(id, endpoint_id, user_id)
) STRICT;

CREATE INDEX turns_user_state_ordinal ON turns(user_id, state, ordinal);
CREATE INDEX outbox_endpoint_state ON outbox(endpoint_id, state, created_at);
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
  const tables = connection
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((entry) => (entry as { name: unknown }).name);
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
