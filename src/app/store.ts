import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Clock, FoundationDatabase } from "../foundation/database.js";
import type { ForgeCatalog, ForgeResolved } from "../forge/types.js";
import type {
  RuntimeModel,
  RuntimeArtifact,
  RuntimeResult,
  RuntimeTurn,
  ThinkingLevel,
} from "../runtime/runtime.js";
import type { Command, WakeCommand } from "./commands.js";
import { AppError } from "./errors.js";

const MAX_SESSIONS_PER_USER = 32;
const MAX_ACTIVE_AND_QUEUED = 4;
const MAX_STAGED_ARTIFACTS = 8;
const MAX_STAGED_TOTAL_BYTES = 40 * 1024 * 1024;
const STAGED_TTL_MS = 10 * 60 * 1000;
const MAX_RESULT_BYTES = 64_000;
const ARTIFACT_ID_PATTERN =
  /^artifact_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

export interface IdSource {
  next(kind: "session" | "pi" | "turn" | "outbox"): string;
}

export const randomIds: IdSource = {
  next: (kind) => (kind === "pi" ? randomUUID() : `${kind}_${randomUUID()}`),
};

export interface EndpointContext {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly platformUserId: string;
  readonly privateChatId: string;
}

export interface MessageIdentity {
  readonly endpoint: EndpointContext;
  readonly idempotencyKey: string;
  readonly contentDigest: string;
}

export interface AdmissionResult {
  readonly turnId: string;
  readonly userId: string;
  readonly duplicate: boolean;
}

export interface CommandResult extends AdmissionResult {
  readonly abortTurnId: string | null;
}

export interface ClaimedTurn extends RuntimeTurn {
  readonly endpointId: string;
}

export interface OutboxDelivery {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly privateChatId: string;
  readonly kind: "text" | "artifact";
  readonly text?: string;
  readonly artifact?: RuntimeArtifact;
}

interface SessionRow {
  readonly id: string;
  readonly name: string;
  readonly state: "active" | "stopped" | "quarantined";
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_RESULT_BYTES) return value;
  return bytes
    .subarray(0, MAX_RESULT_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function outcomeText(result: RuntimeResult): string {
  switch (result.outcome) {
    case "succeeded":
      return result.text.length === 0
        ? "Turn completed."
        : boundedText(result.text);
    case "cancelled":
      return "Turn cancelled.";
    case "failed":
      return result.error === undefined
        ? "agent-failed: the model Turn failed."
        : boundedText(result.error);
    case "timed-out":
      return "agent-failed: the model Turn timed out.";
    case "unknown":
      return "session-quarantined: the model Turn ended in an uncertain state.";
  }
}

function validArtifact(
  artifact: RuntimeArtifact,
  maximumBytes: number,
): boolean {
  const match = ARTIFACT_ID_PATTERN.exec(artifact.id);
  return (
    match?.[1] !== undefined &&
    artifact.storageKey === `${artifact.userId}/${match[1]}.blob` &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(artifact.userId) &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.bytes) &&
    artifact.bytes >= 0 &&
    artifact.bytes <= maximumBytes &&
    (artifact.mediaKind === "image" || artifact.mediaKind === "file") &&
    Buffer.byteLength(artifact.mimeType, "utf8") >= 1 &&
    Buffer.byteLength(artifact.mimeType, "utf8") <= 127 &&
    /^[\x21-\x7e]+\/[\x21-\x7e]+$/u.test(artifact.mimeType) &&
    Buffer.byteLength(artifact.displayName, "utf8") >= 1 &&
    Buffer.byteLength(artifact.displayName, "utf8") <= 128 &&
    !/[\u0000-\u001f\u007f/\\]/u.test(artifact.displayName)
  );
}

export class HitchStore {
  readonly #database: DatabaseSync;

  public constructor(
    foundation: FoundationDatabase,
    readonly ids: IdSource = randomIds,
    readonly clock: Clock = { now: () => Date.now() },
    readonly admissionGuard: (userId: string) => void = () => undefined,
    readonly forgeDefaults: ReadonlyMap<
      string,
      { readonly kind: "profile"; readonly id: string }
    > = new Map(),
  ) {
    this.#database = foundation.connection;
  }

  public resolveTelegramEndpoint(
    accountId: string,
    platformUserId: string,
    privateChatId: string,
  ): EndpointContext | null {
    const row = this.#database
      .prepare(
        `SELECT e.id, e.user_id, e.account_id, e.platform_user_id, e.private_chat_id
         FROM channel_endpoints e
         JOIN users u ON u.id = e.user_id
         WHERE e.kind = 'telegram' AND e.account_id = ? AND e.platform_user_id = ?
           AND e.private_chat_id = ? AND e.enabled = 1 AND u.enabled = 1`,
      )
      .get(accountId, platformUserId, privateChatId) as
      | {
          id: string;
          user_id: string;
          account_id: string;
          platform_user_id: string;
          private_chat_id: string;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          userId: row.user_id,
          accountId: row.account_id,
          platformUserId: row.platform_user_id,
          privateChatId: row.private_chat_id,
        };
  }

  public resolveWeChatEndpoint(
    accountId: string,
    platformUserId: string,
  ): EndpointContext | null {
    const row = this.#database
      .prepare(
        `SELECT e.id, e.user_id, e.account_id, e.platform_user_id
         FROM channel_endpoints e
         JOIN users u ON u.id = e.user_id
         WHERE e.kind = 'wechat' AND e.account_id = ? AND e.platform_user_id = ?
           AND e.private_chat_id IS NULL AND e.enabled = 1 AND u.enabled = 1`,
      )
      .get(accountId, platformUserId) as
      | {
          id: string;
          user_id: string;
          account_id: string;
          platform_user_id: string;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          userId: row.user_id,
          accountId: row.account_id,
          platformUserId: row.platform_user_id,
          privateChatId: row.platform_user_id,
        };
  }

  public resolveWeComEndpoint(
    accountId: string,
    platformUserId: string,
  ): EndpointContext | null {
    const row = this.#database
      .prepare(
        `SELECT e.id, e.user_id, e.account_id, e.platform_user_id
         FROM channel_endpoints e
         JOIN users u ON u.id = e.user_id
         WHERE e.kind = 'wecom' AND e.account_id = ? AND e.platform_user_id = ?
           AND e.private_chat_id IS NULL AND e.enabled = 1 AND u.enabled = 1`,
      )
      .get(accountId, platformUserId) as
      | {
          id: string;
          user_id: string;
          account_id: string;
          platform_user_id: string;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          userId: row.user_id,
          accountId: row.account_id,
          platformUserId: row.platform_user_id,
          privateChatId: row.platform_user_id,
        };
  }

  public endpointContext(endpointId: string): EndpointContext | null {
    const row = this.#database
      .prepare(
        `SELECT e.id, e.user_id, e.account_id, e.platform_user_id, e.private_chat_id
         FROM channel_endpoints e
         JOIN users u ON u.id = e.user_id
         WHERE e.id = ? AND e.enabled = 1 AND u.enabled = 1`,
      )
      .get(endpointId) as
      | {
          id: string;
          user_id: string;
          account_id: string;
          platform_user_id: string;
          private_chat_id: string | null;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          id: row.id,
          userId: row.user_id,
          accountId: row.account_id,
          platformUserId: row.platform_user_id,
          privateChatId: row.private_chat_id ?? row.platform_user_id,
        };
  }

  public getTelegramOffset(accountId: string): number {
    const row = this.#database
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(`telegram_offset:${accountId}`) as { value: string } | undefined;
    if (row === undefined) return 0;
    const value = Number.parseInt(row.value, 10);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new AppError("internal-error", "stored Telegram cursor is invalid");
    return value;
  }

  public artifactStorageKeys(): ReadonlySet<string> {
    const rows = this.#database
      .prepare("SELECT storage_key FROM artifacts")
      .all() as unknown as Array<{ storage_key: string }>;
    return new Set(rows.map(({ storage_key }) => storage_key));
  }

  public setTelegramOffset(accountId: string, offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new AppError("internal-error", "Telegram cursor is invalid");
    this.#database
      .prepare(
        `INSERT INTO app_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(`telegram_offset:${accountId}`, String(offset));
  }

  #nextOrdinal(userId: string): number {
    const row = this.#database
      .prepare(
        "SELECT coalesce(max(ordinal), 0) AS ordinal FROM turns WHERE user_id = ?",
      )
      .get(userId) as {
      ordinal: bigint;
    };
    return Number(row.ordinal) + 1;
  }

  #selectedSession(endpointId: string, userId: string): SessionRow | null {
    const row = this.#database
      .prepare(
        `SELECT s.id, s.name, s.state
         FROM channel_endpoints e
         JOIN sessions s ON s.id = e.selected_session_id AND s.user_id = e.user_id
         WHERE e.id = ? AND e.user_id = ? AND e.enabled = 1`,
      )
      .get(endpointId, userId) as SessionRow | undefined;
    return row ?? null;
  }

  #sessionName(userId: string, requested?: string): string {
    if (requested !== undefined) {
      const exists = this.#database
        .prepare("SELECT 1 FROM sessions WHERE user_id = ? AND name = ?")
        .get(userId, requested);
      if (exists !== undefined)
        throw new AppError("rejected", "session name already exists");
      return requested;
    }
    const count = this.#database
      .prepare("SELECT count(*) AS count FROM sessions WHERE user_id = ?")
      .get(userId) as {
      count: bigint;
    };
    for (
      let suffix = Number(count.count) + 1;
      suffix <= MAX_SESSIONS_PER_USER + 1;
      suffix += 1
    ) {
      const candidate = `session-${suffix}`;
      if (
        this.#database
          .prepare("SELECT 1 FROM sessions WHERE user_id = ? AND name = ?")
          .get(userId, candidate) === undefined
      ) {
        return candidate;
      }
    }
    throw new AppError("busy", "session limit reached");
  }

  #createSession(
    endpointId: string,
    userId: string,
    requestedName?: string,
  ): SessionRow {
    const count = this.#database
      .prepare("SELECT count(*) AS count FROM sessions WHERE user_id = ?")
      .get(userId) as {
      count: bigint;
    };
    if (Number(count.count) >= MAX_SESSIONS_PER_USER)
      throw new AppError("busy", "session limit reached");
    const session: SessionRow = {
      id: this.ids.next("session"),
      name: this.#sessionName(userId, requestedName),
      state: "active",
    };
    const now = this.clock.now();
    this.#database
      .prepare(
        `INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(session.id, userId, session.name, this.ids.next("pi"), now, now);
    const changed = this.#database
      .prepare(
        "UPDATE channel_endpoints SET selected_session_id = ?, updated_at = ? WHERE id = ? AND user_id = ? AND enabled = 1",
      )
      .run(session.id, now, endpointId, userId);
    if (changed.changes !== 1n)
      throw new AppError("rejected", "endpoint is no longer enabled");
    return session;
  }

  #ensurePromptSession(endpointId: string, userId: string): SessionRow {
    const selected = this.#selectedSession(endpointId, userId);
    if (selected === null || selected.state === "stopped")
      return this.#createSession(endpointId, userId);
    if (selected.state === "quarantined")
      throw new AppError(
        "session-quarantined",
        "use !recover before sending another Turn",
      );
    return selected;
  }

  #ensureCommandSession(endpointId: string, userId: string): SessionRow {
    return (
      this.#selectedSession(endpointId, userId) ??
      this.#createSession(endpointId, userId)
    );
  }

  #existingMessage(
    identity: MessageIdentity,
  ): { turnId: string; userId: string } | null {
    const row = this.#database
      .prepare(
        "SELECT id, user_id, content_digest FROM turns WHERE endpoint_id = ? AND idempotency_key = ?",
      )
      .get(identity.endpoint.id, identity.idempotencyKey) as
      | { id: string; user_id: string; content_digest: string }
      | undefined;
    if (row === undefined) return null;
    if (
      row.user_id !== identity.endpoint.userId ||
      row.content_digest !== identity.contentDigest
    ) {
      throw new AppError(
        "rejected",
        "idempotency key was reused with different content",
      );
    }
    return { turnId: row.id, userId: row.user_id };
  }

  #pinnedSession(sessionId: string, userId: string): { id: string } | null {
    const row = this.#database
      .prepare("SELECT state FROM sessions WHERE id = ? AND user_id = ?")
      .get(sessionId, userId) as { state: string } | undefined;
    return row !== undefined && row.state === "active"
      ? { id: sessionId }
      : null;
  }

  /**
   * Wake-fired context rotation: reset the selected session's Pi state (fresh
   * transcript) while keeping the Hitch session row, name, and selections.
   * No-op when a Turn is in flight — completion still writes to the old
   * transcript, and clobbering mid-Turn state would be worse than one
   * fire continuing the previous context.
   */
  public resetSessionPiStateForWake(
    endpointId: string,
    userId: string,
  ): { id: string } {
    return transaction(this.#database, () => {
      const selected = this.#selectedSession(endpointId, userId);
      if (selected === null || selected.state === "stopped")
        return this.#createSession(endpointId, userId);
      if (selected.state === "quarantined")
        throw new AppError(
          "session-quarantined",
          "use !recover before sending another Turn",
        );
      const active = this.#database
        .prepare(
          "SELECT 1 FROM turns WHERE user_id = ? AND state IN ('starting', 'running') LIMIT 1",
        )
        .get(userId);
      if (active !== undefined) return { id: selected.id };
      this.#database
        .prepare(
          "UPDATE sessions SET pi_session_id = ?, transcript_path = NULL, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .run(this.ids.next("pi"), this.clock.now(), selected.id, userId);
      return { id: selected.id };
    });
  }

  public admitPrompt(
    identity: MessageIdentity,
    prompt: string,
    artifacts: readonly RuntimeArtifact[] = [],
    pinnedSessionId?: string,
  ): AdmissionResult {
    return transaction(this.#database, () => {
      const existing = this.#existingMessage(identity);
      if (existing !== null) return { ...existing, duplicate: true };
      this.admissionGuard(identity.endpoint.userId);
      const session =
        (pinnedSessionId !== undefined
          ? this.#pinnedSession(pinnedSessionId, identity.endpoint.userId)
          : null) ??
        this.#ensurePromptSession(
          identity.endpoint.id,
          identity.endpoint.userId,
        );
      const capacity = this.#database
        .prepare(
          "SELECT count(*) AS count FROM turns WHERE user_id = ? AND state IN ('queued', 'starting', 'running')",
        )
        .get(identity.endpoint.userId) as { count: bigint };
      if (Number(capacity.count) >= MAX_ACTIVE_AND_QUEUED)
        throw new AppError(
          "busy",
          "one Turn is active and three are already queued",
        );
      const turnId = this.ids.next("turn");
      const now = this.clock.now();
      if (
        artifacts.length > 8 ||
        artifacts.reduce((total, artifact) => total + artifact.bytes, 0) >
          40 * 1024 * 1024 ||
        new Set(artifacts.map(({ id }) => id)).size !== artifacts.length ||
        artifacts.some(
          (artifact) =>
            artifact.userId !== identity.endpoint.userId ||
            artifact.bytes < 1 ||
            !validArtifact(artifact, 20 * 1024 * 1024),
        )
      ) {
        throw new AppError("media-invalid", "Turn media bounds are invalid");
      }
      this.#database
        .prepare(
          `INSERT INTO turns(
             id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
             prompt_text, ordinal, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          turnId,
          identity.endpoint.userId,
          session.id,
          identity.endpoint.id,
          identity.idempotencyKey,
          identity.contentDigest,
          prompt,
          this.#nextOrdinal(identity.endpoint.userId),
          now,
          now,
        );
      for (const [ordinal, artifact] of artifacts.entries()) {
        this.#insertArtifact(artifact, now);
        this.#database
          .prepare(
            `INSERT INTO turn_artifacts(turn_id, user_id, artifact_id, direction, ordinal)
             VALUES (?, ?, ?, 'inbound', ?)`,
          )
          .run(turnId, identity.endpoint.userId, artifact.id, ordinal);
      }
      return { turnId, userId: identity.endpoint.userId, duplicate: false };
    });
  }

  #insertArtifact(artifact: RuntimeArtifact, now: number): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO artifacts(
           id, user_id, storage_key, sha256, bytes, media_kind, mime_type, display_name, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.userId,
        artifact.storageKey,
        artifact.sha256,
        artifact.bytes,
        artifact.mediaKind,
        artifact.mimeType,
        artifact.displayName,
        now,
      );
  }

  #insertOutbox(
    userId: string,
    endpointId: string,
    turnId: string | null,
    text: string,
  ): void {
    const now = this.clock.now();
    this.#database
      .prepare(
        `INSERT INTO outbox(
           id, user_id, endpoint_id, turn_id, kind, payload_text, state, attempts, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'text', ?, 'pending', 0, ?, ?)`,
      )
      .run(
        this.ids.next("outbox"),
        userId,
        endpointId,
        turnId,
        boundedText(text),
        now,
        now,
      );
  }

  #insertArtifactOutbox(
    userId: string,
    endpointId: string,
    turnId: string,
    artifactId: string,
  ): void {
    const now = this.clock.now();
    this.#database
      .prepare(
        `INSERT INTO outbox(
           id, user_id, endpoint_id, turn_id, artifact_id, kind, payload_text,
           state, attempts, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'artifact', NULL, 'pending', 0, ?, ?)`,
      )
      .run(
        this.ids.next("outbox"),
        userId,
        endpointId,
        turnId,
        artifactId,
        now,
        now,
      );
  }

  #listSessions(userId: string, selectedId: string): string {
    const rows = this.#database
      .prepare(
        "SELECT id, name, state FROM sessions WHERE user_id = ? ORDER BY created_at, id",
      )
      .all(userId) as unknown as SessionRow[];
    return rows
      .map((session) => {
        const selector = session.id.startsWith("session_")
          ? session.id.slice(8, 16)
          : session.id.slice(0, 8);
        return `${session.id === selectedId ? "*" : "-"} ${selector} ${session.name} (${session.state})`;
      })
      .join("\n");
  }

  #findSession(userId: string, selector: string): SessionRow {
    const rows = this.#database
      .prepare(
        `SELECT id, name, state FROM sessions
         WHERE user_id = ? AND state != 'stopped'
           AND (name = ? OR id = ? OR substr(id, 9, length(?)) = ?)`,
      )
      .all(
        userId,
        selector,
        selector,
        selector,
        selector,
      ) as unknown as SessionRow[];
    if (rows.length !== 1 || rows[0] === undefined)
      throw new AppError(
        "rejected",
        "session selector is unknown or ambiguous",
      );
    return rows[0];
  }

  #rejectSelectionDuringActiveTurn(userId: string, sessionId: string): void {
    const active = this.#database
      .prepare(
        `SELECT 1 FROM turns
         WHERE user_id = ? AND session_id = ? AND state IN ('starting', 'running')
         LIMIT 1`,
      )
      .get(userId, sessionId);
    if (active !== undefined)
      throw new AppError(
        "busy",
        "wait for the active Turn before changing model selection",
      );
  }

  #rejectBusySessionForForge(userId: string, sessionId: string): void {
    const busy = this.#database
      .prepare(
        `SELECT 1 FROM turns
         WHERE user_id = ? AND session_id = ? AND state IN ('queued', 'starting', 'running')
         LIMIT 1`,
      )
      .get(userId, sessionId);
    if (busy !== undefined)
      throw new AppError(
        "busy",
        "wait for active and queued Turns before changing Forge selection",
      );
  }

  public executeCommand(
    identity: MessageIdentity,
    command: Command,
    sourceText: string,
    models: readonly RuntimeModel[] = [],
    forge?: ForgeCatalog,
    wakeHandler?: (
      identity: MessageIdentity,
      command: WakeCommand,
      sessionId: string,
    ) => string,
  ): CommandResult {
    return transaction(this.#database, () => {
      const existing = this.#existingMessage(identity);
      if (existing !== null)
        return { ...existing, duplicate: true, abortTurnId: null };

      let session =
        command.kind === "new"
          ? this.#createSession(
              identity.endpoint.id,
              identity.endpoint.userId,
              command.name,
            )
          : this.#ensureCommandSession(
              identity.endpoint.id,
              identity.endpoint.userId,
            );
      let response = "";
      let commandSucceeded = true;
      let abortTurnId: string | null = null;
      const now = this.clock.now();

      switch (command.kind) {
        case "new":
          response = `Created and selected ${session.name}.`;
          break;
        case "sessions":
          response = this.#listSessions(identity.endpoint.userId, session.id);
          break;
        case "switch": {
          session = this.#findSession(
            identity.endpoint.userId,
            command.selector,
          );
          this.#database
            .prepare(
              "UPDATE channel_endpoints SET selected_session_id = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            )
            .run(
              session.id,
              now,
              identity.endpoint.id,
              identity.endpoint.userId,
            );
          response = `Selected ${session.name}.`;
          break;
        }
        case "status": {
          const counts = this.#database
            .prepare(
              `SELECT
                 sum(CASE WHEN state IN ('starting', 'running') THEN 1 ELSE 0 END) AS active,
                 sum(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued
               FROM turns WHERE user_id = ?`,
            )
            .get(identity.endpoint.userId) as {
            active: bigint | null;
            queued: bigint | null;
          };
          const selection = this.#database
            .prepare(
              "SELECT model_provider, model_id, thinking_level FROM sessions WHERE id = ? AND user_id = ?",
            )
            .get(session.id, identity.endpoint.userId) as {
            model_provider: string | null;
            model_id: string | null;
            thinking_level: string | null;
          };
          const model =
            selection.model_provider === null || selection.model_id === null
              ? "Pi default"
              : `${selection.model_provider}/${selection.model_id}`;
          const running = this.#database
            .prepare(
              "SELECT updated_at FROM turns WHERE user_id = ? AND state = 'running' ORDER BY ordinal LIMIT 1",
            )
            .get(identity.endpoint.userId) as
            | { updated_at: number }
            | undefined;
          const staged = this.stagedArtifactCount(identity.endpoint.userId);
          const elapsed =
            running === undefined
              ? ""
              : `; elapsed ${Math.max(0, now - running.updated_at) / 1000}s`;
          response = `Session ${session.name} (${session.state}); model ${model}; thinking ${selection.thinking_level ?? "Pi default"}; active ${Number(counts.active ?? 0n)}; queued ${Number(counts.queued ?? 0n)}${elapsed}${staged === 0 ? "" : `; staged ${staged}`}.`;
          break;
        }
        case "abort": {
          const active = this.#database
            .prepare(
              "SELECT id FROM turns WHERE user_id = ? AND state IN ('starting', 'running') ORDER BY ordinal LIMIT 1",
            )
            .get(identity.endpoint.userId) as { id: string } | undefined;
          abortTurnId = active?.id ?? null;
          response =
            abortTurnId === null ? "No active Turn." : "Abort requested.";
          break;
        }
        case "stop": {
          this.#database
            .prepare(
              "UPDATE sessions SET state = 'stopped', updated_at = ? WHERE id = ? AND user_id = ?",
            )
            .run(now, session.id, identity.endpoint.userId);
          this.#database
            .prepare(
              `UPDATE turns SET state = 'terminal', outcome = 'cancelled', result_text = 'Turn cancelled.', updated_at = ?
               WHERE user_id = ? AND session_id = ? AND state = 'queued'`,
            )
            .run(now, identity.endpoint.userId, session.id);
          const active = this.#database
            .prepare(
              "SELECT id FROM turns WHERE user_id = ? AND session_id = ? AND state IN ('starting', 'running') LIMIT 1",
            )
            .get(identity.endpoint.userId, session.id) as
            | { id: string }
            | undefined;
          abortTurnId = active?.id ?? null;
          response = `Stopped ${session.name}.`;
          break;
        }
        case "recover": {
          if (session.state !== "quarantined")
            throw new AppError(
              "rejected",
              "selected session is not quarantined",
            );
          this.#database
            .prepare(
              `UPDATE turns SET state = 'terminal', outcome = 'cancelled', result_text = 'Turn cancelled.', updated_at = ?
               WHERE user_id = ? AND session_id = ? AND state = 'queued'`,
            )
            .run(now, identity.endpoint.userId, session.id);
          this.#database
            .prepare(
              "UPDATE sessions SET state = 'stopped', updated_at = ? WHERE id = ? AND user_id = ?",
            )
            .run(now, session.id, identity.endpoint.userId);
          session = this.#createSession(
            identity.endpoint.id,
            identity.endpoint.userId,
          );
          response = `Recovered into ${session.name}; unknown work was not replayed.`;
          break;
        }
        case "models": {
          const filter = command.filter?.toLocaleLowerCase("en-US");
          const matches = models
            .filter((model) => {
              if (filter === undefined) return true;
              return `${model.provider}/${model.id} ${model.name}`
                .toLocaleLowerCase("en-US")
                .includes(filter);
            })
            .slice(0, 50);
          if (matches.length === 0)
            throw new AppError(
              "model-unavailable",
              "no available model matches that filter",
            );
          response = matches
            .map(
              (model) =>
                `${model.provider}/${model.id}${model.reasoning ? " (reasoning)" : ""}`,
            )
            .join("\n");
          break;
        }
        case "model": {
          this.#rejectSelectionDuringActiveTurn(
            identity.endpoint.userId,
            session.id,
          );
          const separator = command.selector.indexOf("/");
          if (separator <= 0 || separator === command.selector.length - 1) {
            throw new AppError(
              "rejected",
              "model selector must be provider/model",
            );
          }
          const provider = command.selector.slice(0, separator);
          const modelId = command.selector.slice(separator + 1);
          const model = models.find(
            (candidate) =>
              candidate.provider === provider && candidate.id === modelId,
          );
          if (model === undefined)
            throw new AppError(
              "model-unavailable",
              "model is not in the current Pi catalog",
            );
          const changed = this.#database
            .prepare(
              `UPDATE sessions
               SET model_provider = ?, model_id = ?, thinking_level = ?, updated_at = ?
               WHERE id = ? AND user_id = ? AND state = 'active'`,
            )
            .run(
              model.provider,
              model.id,
              model.thinkingLevels[0] ?? "off",
              now,
              session.id,
              identity.endpoint.userId,
            );
          if (changed.changes !== 1n)
            throw new AppError(
              "session-quarantined",
              "selected session is not active; use !recover or !new",
            );
          response = `Selected model ${model.provider}/${model.id}.`;
          break;
        }
        case "thinking": {
          this.#rejectSelectionDuringActiveTurn(
            identity.endpoint.userId,
            session.id,
          );
          const allowed: readonly ThinkingLevel[] = [
            "off",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ];
          if (!allowed.includes(command.level as ThinkingLevel))
            throw new AppError("rejected", "thinking level is invalid");
          const selected = this.#database
            .prepare(
              "SELECT model_provider, model_id FROM sessions WHERE id = ? AND user_id = ? AND state = 'active'",
            )
            .get(session.id, identity.endpoint.userId) as
            | { model_provider: string | null; model_id: string | null }
            | undefined;
          const model = models.find(
            (candidate) =>
              candidate.provider === selected?.model_provider &&
              candidate.id === selected?.model_id,
          );
          if (model === undefined)
            throw new AppError(
              "model-unavailable",
              "select an available model before setting thinking",
            );
          if (!model.thinkingLevels.includes(command.level as ThinkingLevel))
            throw new AppError(
              "model-unavailable",
              "thinking level is not supported by the selected model",
            );
          this.#database
            .prepare(
              "UPDATE sessions SET thinking_level = ?, updated_at = ? WHERE id = ? AND user_id = ? AND state = 'active'",
            )
            .run(command.level, now, session.id, identity.endpoint.userId);
          response = `Selected thinking level ${command.level}.`;
          break;
        }
        case "preset":
        case "profile": {
          if (
            forge === undefined ||
            !forge.isEnabled(identity.endpoint.userId)
          ) {
            throw new AppError(
              "rejected",
              "Forge is not enabled for this user",
            );
          }

          if (command.action === "list") {
            const items = forge.list(command.kind);
            if (items.length === 0) {
              response = `No ${command.kind}s available.`;
            } else {
              response = items
                .slice(0, 128)
                .map((item) =>
                  item.name.length > 0 && item.name !== item.id
                    ? `${item.id} - ${item.name}`
                    : item.id,
                )
                .join("\n");
            }
            break;
          }

          if (command.action === "preview") {
            let resolved: ForgeResolved;
            try {
              resolved = forge.resolve({
                kind: command.kind,
                id: command.id,
              });
            } catch (error) {
              if (error instanceof AppError) throw error;
              throw new AppError(
                "rejected",
                `${command.kind} '${command.id}' not found or invalid`,
              );
            }
            const lines: string[] = [
              `${command.kind === "preset" ? "Preset" : "Profile"}: ${resolved.name} (${resolved.selection.id})`,
              `Mode: ${resolved.mode}`,
            ];
            if (resolved.model !== undefined) {
              lines.push(
                `Model: ${resolved.model.provider}/${resolved.model.id}`,
              );
            }
            if (resolved.thinkingLevel !== undefined) {
              lines.push(`Thinking: ${resolved.thinkingLevel}`);
            }
            if (
              resolved.tools?.allow !== undefined &&
              resolved.tools.allow.length > 0
            ) {
              lines.push(`Tools allow: ${resolved.tools.allow.join(", ")}`);
            }
            if (
              resolved.tools?.deny !== undefined &&
              resolved.tools.deny.length > 0
            ) {
              lines.push(`Tools deny: ${resolved.tools.deny.join(", ")}`);
            }
            lines.push("--- System Prompt ---");
            lines.push(resolved.systemPrompt);
            response = lines.join("\n");
            break;
          }

          if (command.action === "status") {
            const selection = this.#database
              .prepare(
                "SELECT forge_kind, forge_id FROM sessions WHERE id = ? AND user_id = ?",
              )
              .get(session.id, identity.endpoint.userId) as
              | {
                  forge_kind: string | null;
                  forge_id: string | null;
                }
              | undefined;
            if (
              selection?.forge_kind === command.kind &&
              selection.forge_id !== null
            ) {
              response = `Selected ${command.kind}: ${selection.forge_id}.`;
            } else {
              response = `No ${command.kind} selected.`;
            }
            break;
          }

          if (command.action === "clear") {
            this.#rejectBusySessionForForge(
              identity.endpoint.userId,
              session.id,
            );
            const selected = this.#database
              .prepare(
                "SELECT forge_kind FROM sessions WHERE id = ? AND user_id = ?",
              )
              .get(session.id, identity.endpoint.userId) as {
              forge_kind: string | null;
            };
            if (selected.forge_kind !== command.kind) {
              response = `No ${command.kind} selected.`;
              break;
            }
            const changed = this.#database
              .prepare(
                `UPDATE sessions
                 SET forge_kind = NULL, forge_id = NULL, updated_at = ?
                 WHERE id = ? AND user_id = ? AND state = 'active'`,
              )
              .run(now, session.id, identity.endpoint.userId);
            if (changed.changes !== 1n) {
              throw new AppError(
                "session-quarantined",
                "selected session is not active; use !recover or !new",
              );
            }
            response = `Cleared ${command.kind} selection.`;
            break;
          }

          if (command.action === "use") {
            this.#rejectBusySessionForForge(
              identity.endpoint.userId,
              session.id,
            );
            let resolved: ForgeResolved;
            try {
              resolved = forge.resolve({
                kind: command.kind,
                id: command.id,
              });
            } catch (error) {
              if (error instanceof AppError) throw error;
              throw new AppError(
                "rejected",
                `${command.kind} '${command.id}' not found or invalid`,
              );
            }

            if (command.kind === "preset") {
              const changed = this.#database
                .prepare(
                  `UPDATE sessions
                   SET forge_kind = 'preset', forge_id = ?, updated_at = ?
                   WHERE id = ? AND user_id = ? AND state = 'active'`,
                )
                .run(
                  resolved.selection.id,
                  now,
                  session.id,
                  identity.endpoint.userId,
                );
              if (changed.changes !== 1n) {
                throw new AppError(
                  "session-quarantined",
                  "selected session is not active; use !recover or !new",
                );
              }
              response = `Selected preset ${resolved.selection.id}.`;
              break;
            }

            let modelProvider: string | null = null;
            let modelId: string | null = null;
            let thinkingLevel: string | null = null;

            if (resolved.model !== undefined) {
              const targetModel = models.find(
                (candidate) =>
                  candidate.provider === resolved.model?.provider &&
                  candidate.id === resolved.model?.id,
              );
              if (targetModel === undefined) {
                throw new AppError(
                  "model-unavailable",
                  "profile model is not in the current Pi catalog",
                );
              }
              modelProvider = targetModel.provider;
              modelId = targetModel.id;

              if (resolved.thinkingLevel !== undefined) {
                if (
                  !targetModel.thinkingLevels.includes(resolved.thinkingLevel)
                ) {
                  throw new AppError(
                    "model-unavailable",
                    "profile thinking level is not supported by the model",
                  );
                }
                thinkingLevel = resolved.thinkingLevel;
              } else {
                thinkingLevel = targetModel.thinkingLevels[0] ?? "off";
              }
            } else {
              const current = this.#database
                .prepare(
                  "SELECT model_provider, model_id, thinking_level FROM sessions WHERE id = ? AND user_id = ? AND state = 'active'",
                )
                .get(session.id, identity.endpoint.userId) as
                | {
                    model_provider: string | null;
                    model_id: string | null;
                    thinking_level: string | null;
                  }
                | undefined;

              if (
                current !== undefined &&
                current.model_provider !== null &&
                current.model_id !== null
              ) {
                const currentModel = models.find(
                  (candidate) =>
                    candidate.provider === current.model_provider &&
                    candidate.id === current.model_id,
                );
                if (currentModel === undefined) {
                  throw new AppError(
                    "model-unavailable",
                    "current session model is not in the Pi catalog",
                  );
                }
                modelProvider = current.model_provider;
                modelId = current.model_id;
                if (resolved.thinkingLevel !== undefined) {
                  if (
                    !currentModel.thinkingLevels.includes(
                      resolved.thinkingLevel,
                    )
                  ) {
                    throw new AppError(
                      "model-unavailable",
                      "profile thinking level is not supported by the current model",
                    );
                  }
                  thinkingLevel = resolved.thinkingLevel;
                } else {
                  thinkingLevel = current.thinking_level;
                }
              } else {
                if (resolved.thinkingLevel !== undefined) {
                  const fallbackModel = models[0];
                  if (fallbackModel === undefined) {
                    throw new AppError(
                      "model-unavailable",
                      "select an available model before setting thinking",
                    );
                  }
                  if (
                    !fallbackModel.thinkingLevels.includes(
                      resolved.thinkingLevel,
                    )
                  ) {
                    throw new AppError(
                      "model-unavailable",
                      "profile thinking level is not supported by the current model",
                    );
                  }
                  thinkingLevel = resolved.thinkingLevel;
                } else {
                  thinkingLevel = current?.thinking_level ?? null;
                }
                modelProvider = null;
                modelId = null;
              }
            }

            const changed = this.#database
              .prepare(
                `UPDATE sessions
                 SET forge_kind = 'profile', forge_id = ?, model_provider = ?, model_id = ?, thinking_level = ?, updated_at = ?
                 WHERE id = ? AND user_id = ? AND state = 'active'`,
              )
              .run(
                resolved.selection.id,
                modelProvider,
                modelId,
                thinkingLevel,
                now,
                session.id,
                identity.endpoint.userId,
              );
            if (changed.changes !== 1n) {
              throw new AppError(
                "session-quarantined",
                "selected session is not active; use !recover or !new",
              );
            }
            response = `Selected profile ${resolved.selection.id}.`;
            break;
          }
          break;
        }
        case "compact": {
          if (session.state !== "active")
            throw new AppError(
              "session-quarantined",
              "selected session is not active; use !recover or !new",
            );
          this.admissionGuard(identity.endpoint.userId);
          const capacity = this.#database
            .prepare(
              "SELECT count(*) AS count FROM turns WHERE user_id = ? AND state IN ('queued', 'starting', 'running')",
            )
            .get(identity.endpoint.userId) as { count: bigint };
          if (Number(capacity.count) >= MAX_ACTIVE_AND_QUEUED)
            throw new AppError(
              "busy",
              "one Turn is active and three are already queued",
            );
          const turnId = this.ids.next("turn");
          const now = this.clock.now();
          this.#database
            .prepare(
              `INSERT INTO turns(
                 id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
                 prompt_text, operation_kind, ordinal, state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'compact', ?, 'queued', ?, ?)`,
            )
            .run(
              turnId,
              identity.endpoint.userId,
              session.id,
              identity.endpoint.id,
              identity.idempotencyKey,
              identity.contentDigest,
              sourceText,
              this.#nextOrdinal(identity.endpoint.userId),
              now,
              now,
            );
          return {
            turnId,
            userId: identity.endpoint.userId,
            duplicate: false,
            abortTurnId: null,
          };
        }
        case "send": {
          if (session.state !== "active")
            throw new AppError(
              "session-quarantined",
              "selected session is not active; use !recover or !new",
            );
          const workspace = this.#database
            .prepare(
              "SELECT workspace_path FROM users WHERE id = ? AND enabled = 1",
            )
            .get(identity.endpoint.userId) as
            | { workspace_path: string }
            | undefined;
          this.admissionGuard(identity.endpoint.userId);
          if (workspace === undefined)
            throw new AppError("internal-error", "workspace is unavailable");
          const target = resolve(workspace.workspace_path, command.path);
          if (
            target !== workspace.workspace_path &&
            !target.startsWith(`${workspace.workspace_path}${sep}`)
          ) {
            throw new AppError(
              "rejected",
              "publish path must stay inside the workspace",
            );
          }
          let metadata;
          try {
            metadata = statSync(target);
          } catch {
            throw new AppError(
              "rejected",
              "publish path does not exist in the workspace",
            );
          }
          if (!metadata.isFile())
            throw new AppError(
              "rejected",
              "publish path is not a regular file in the workspace",
            );
          const capacity = this.#database
            .prepare(
              "SELECT count(*) AS count FROM turns WHERE user_id = ? AND state IN ('queued', 'starting', 'running')",
            )
            .get(identity.endpoint.userId) as { count: bigint };
          if (Number(capacity.count) >= MAX_ACTIVE_AND_QUEUED)
            throw new AppError(
              "busy",
              "one Turn is active and three are already queued",
            );
          const turnId = this.ids.next("turn");
          this.#database
            .prepare(
              `INSERT INTO turns(
                 id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
                 prompt_text, operation_kind, publish_path, ordinal, state, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'publish', ?, ?, 'queued', ?, ?)`,
            )
            .run(
              turnId,
              identity.endpoint.userId,
              session.id,
              identity.endpoint.id,
              identity.idempotencyKey,
              identity.contentDigest,
              sourceText,
              command.path,
              this.#nextOrdinal(identity.endpoint.userId),
              now,
              now,
            );
          return {
            turnId,
            userId: identity.endpoint.userId,
            duplicate: false,
            abortTurnId: null,
          };
        }
        case "help":
          response = [
            "!new [name] - create and select a session",
            "!sessions - list sessions",
            "!switch <id-or-name> - select a session",
            "!status - session, model, queue, and sandbox state",
            "!abort - cancel the active Turn",
            "!stop - stop the session and cancel queued Turns",
            "!recover - replace a quarantined session",
            "!models [filter] - list available models",
            "!model <provider>/<id> - select a model",
            "!thinking <level> - select a thinking level",
            "!preset [list|use <id>|preview <id>|status|clear] - manage preset prompt stacks",
            "!profile [list|use <id>|preview <id>|status|clear] - manage persona profiles",
            "!wake [add|list|del|pause|resume|tz] - manage scheduled wake-ups",
            "!send <relative-path> - publish a workspace file",
            "!compact - compact the session context",
            "!help - show this list",
          ].join("\n");
          break;
        case "wake": {
          if (wakeHandler === undefined) {
            response = "rejected: wake schedules are not available";
            commandSucceeded = false;
            break;
          }
          response = wakeHandler(identity, command, session.id);
          break;
        }
        case "unknown":
          response = `rejected: unknown command !${command.name}`;
          commandSucceeded = false;
          break;
      }

      const turnId = this.ids.next("turn");
      this.#database
        .prepare(
          `INSERT INTO turns(
             id, user_id, session_id, endpoint_id, idempotency_key, content_digest,
             prompt_text, ordinal, state, outcome, result_text, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'terminal', ?, ?, ?, ?)`,
        )
        .run(
          turnId,
          identity.endpoint.userId,
          session.id,
          identity.endpoint.id,
          identity.idempotencyKey,
          identity.contentDigest,
          sourceText,
          this.#nextOrdinal(identity.endpoint.userId),
          commandSucceeded ? "succeeded" : "failed",
          response,
          now,
          now,
        );
      this.#insertOutbox(
        identity.endpoint.userId,
        identity.endpoint.id,
        turnId,
        response,
      );
      return {
        turnId,
        userId: identity.endpoint.userId,
        duplicate: false,
        abortTurnId,
      };
    });
  }

  public claimNextTurn(userId: string): ClaimedTurn | null {
    return transaction(this.#database, () => {
      const active = this.#database
        .prepare(
          "SELECT 1 FROM turns WHERE user_id = ? AND state IN ('starting', 'running') LIMIT 1",
        )
        .get(userId);
      if (active !== undefined) return null;
      const row = this.#database
        .prepare(
          `SELECT t.id, t.user_id, t.session_id, t.endpoint_id, t.prompt_text,
                  t.operation_kind, t.publish_path,
                  u.workspace_path, s.pi_session_id, s.transcript_path,
                  s.model_provider, s.model_id, s.thinking_level,
                  s.forge_kind, s.forge_id
           FROM turns t
           JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
           JOIN users u ON u.id = t.user_id
           WHERE t.user_id = ? AND t.state = 'queued' AND s.state = 'active'
           ORDER BY t.ordinal LIMIT 1`,
        )
        .get(userId) as
        | {
            id: string;
            user_id: string;
            session_id: string;
            endpoint_id: string;
            prompt_text: string;
            operation_kind: "prompt" | "publish" | "compact";
            publish_path: string | null;
            workspace_path: string;
            pi_session_id: string;
            transcript_path: string | null;
            model_provider: string | null;
            model_id: string | null;
            thinking_level: ThinkingLevel | null;
            forge_kind: "preset" | "profile" | null;
            forge_id: string | null;
          }
        | undefined;
      if (row === undefined) return null;
      const artifacts = this.#database
        .prepare(
          `SELECT a.id, a.user_id AS userId, a.storage_key AS storageKey,
                  a.sha256, a.bytes, a.media_kind AS mediaKind,
                  a.mime_type AS mimeType, a.display_name AS displayName
           FROM turn_artifacts ta
           JOIN artifacts a ON a.id = ta.artifact_id AND a.user_id = ta.user_id
           WHERE ta.turn_id = ? AND ta.user_id = ? AND ta.direction = 'inbound'
           ORDER BY ta.ordinal`,
        )
        .all(row.id, userId)
        .map((value) => {
          const artifact = value as Omit<RuntimeArtifact, "bytes"> & {
            bytes: bigint;
          };
          return { ...artifact, bytes: Number(artifact.bytes) };
        });
      const changed = this.#database
        .prepare(
          "UPDATE turns SET state = 'running', updated_at = ? WHERE id = ? AND user_id = ? AND state = 'queued'",
        )
        .run(this.clock.now(), row.id, userId);
      if (changed.changes !== 1n) return null;
      const forgeSelection =
        row.forge_kind !== null && row.forge_id !== null
          ? {
              kind: row.forge_kind,
              id: row.forge_id,
            }
          : this.forgeDefaults.get(row.user_id);
      return {
        turnId: row.id,
        userId: row.user_id,
        sessionId: row.session_id,
        endpointId: row.endpoint_id,
        prompt: row.prompt_text,
        workspace: row.workspace_path,
        piSessionId: row.pi_session_id,
        ...(row.transcript_path === null
          ? {}
          : { transcriptPath: row.transcript_path }),
        ...(row.model_provider === null
          ? {}
          : { modelProvider: row.model_provider }),
        ...(row.model_id === null ? {} : { modelId: row.model_id }),
        ...(row.thinking_level === null
          ? {}
          : { thinkingLevel: row.thinking_level }),
        ...(forgeSelection === undefined ? {} : { forgeSelection }),
        ...(artifacts.length === 0 ? {} : { artifacts }),
        ...(row.operation_kind === "publish" && row.publish_path !== null
          ? { publishPath: row.publish_path }
          : {}),
        ...(row.operation_kind === "compact" ? { compact: true } : {}),
      };
    });
  }

  public hasDispatchableTurn(userId: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM turns t
           JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
           WHERE t.user_id = ? AND t.state = 'queued' AND s.state = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM turns active
               WHERE active.user_id = t.user_id AND active.state IN ('starting', 'running')
             )
           LIMIT 1`,
        )
        .get(userId) !== undefined
    );
  }

  public insertTurnProgress(turn: ClaimedTurn, text: string): void {
    transaction(this.#database, () => {
      const stillRunning = this.#database
        .prepare(
          "SELECT 1 FROM turns WHERE id = ? AND user_id = ? AND state = 'running'",
        )
        .get(turn.turnId, turn.userId);
      if (stillRunning === undefined) return;
      this.#insertOutbox(turn.userId, turn.endpointId, turn.turnId, text);
    });
  }

  public completeTurn(turn: ClaimedTurn, result: RuntimeResult): void {
    transaction(this.#database, () => {
      const now = this.clock.now();
      const text = outcomeText(result);
      const changed = this.#database
        .prepare(
          `UPDATE turns SET state = 'terminal', outcome = ?, result_text = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND session_id = ? AND endpoint_id = ? AND state = 'running'`,
        )
        .run(
          result.outcome,
          text,
          now,
          turn.turnId,
          turn.userId,
          turn.sessionId,
          turn.endpointId,
        );
      if (changed.changes !== 1n)
        throw new AppError(
          "internal-error",
          "active Turn state changed unexpectedly",
        );
      if (!result.sessionReusable || result.outcome === "unknown") {
        this.#database
          .prepare(
            "UPDATE sessions SET state = 'quarantined', updated_at = ? WHERE id = ? AND user_id = ?",
          )
          .run(now, turn.sessionId, turn.userId);
      }
      if (result.sessionReusable) {
        this.#database
          .prepare(
            `UPDATE sessions
             SET transcript_path = coalesce(?, transcript_path),
                 model_provider = coalesce(?, model_provider),
                 model_id = coalesce(?, model_id),
                 thinking_level = coalesce(?, thinking_level),
                 updated_at = ?
             WHERE id = ? AND user_id = ?`,
          )
          .run(
            result.transcriptPath ?? null,
            result.modelProvider ?? null,
            result.modelId ?? null,
            result.thinkingLevel ?? null,
            now,
            turn.sessionId,
            turn.userId,
          );
      }
      this.#insertOutbox(turn.userId, turn.endpointId, turn.turnId, text);
      const artifacts = result.artifacts ?? [];
      if (
        artifacts.length > 8 ||
        new Set(artifacts.map(({ id }) => id)).size !== artifacts.length ||
        artifacts.some(
          (artifact) =>
            artifact.userId !== turn.userId ||
            !validArtifact(artifact, 50 * 1024 * 1024),
        )
      ) {
        throw new AppError(
          "internal-error",
          "runtime publication bounds are invalid",
        );
      }
      for (const [ordinal, artifact] of artifacts.entries()) {
        this.#insertArtifact(artifact, now);
        this.#database
          .prepare(
            `INSERT INTO turn_artifacts(turn_id, user_id, artifact_id, direction, ordinal)
             VALUES (?, ?, ?, 'outbound', ?)`,
          )
          .run(turn.turnId, turn.userId, artifact.id, ordinal);
        this.#insertArtifactOutbox(
          turn.userId,
          turn.endpointId,
          turn.turnId,
          artifact.id,
        );
      }
    });
  }

  public recoverAfterRestart(): readonly string[] {
    return transaction(this.#database, () => {
      const uncertain = this.#database
        .prepare(
          "SELECT id, user_id, session_id, endpoint_id FROM turns WHERE state IN ('starting', 'running') ORDER BY ordinal",
        )
        .all() as unknown as Array<{
        id: string;
        user_id: string;
        session_id: string;
        endpoint_id: string;
      }>;
      const now = this.clock.now();
      for (const turn of uncertain) {
        const text =
          "session-quarantined: previous work ended in an uncertain state after restart.";
        this.#database
          .prepare(
            `UPDATE turns SET state = 'terminal', outcome = 'unknown', result_text = ?, updated_at = ?
             WHERE id = ? AND user_id = ?`,
          )
          .run(text, now, turn.id, turn.user_id);
        this.#database
          .prepare(
            "UPDATE sessions SET state = 'quarantined', updated_at = ? WHERE id = ? AND user_id = ?",
          )
          .run(now, turn.session_id, turn.user_id);
        this.#insertOutbox(turn.user_id, turn.endpoint_id, turn.id, text);
      }
      this.#database
        .prepare(
          "UPDATE outbox SET state = 'retryable', updated_at = ? WHERE state = 'sending'",
        )
        .run(now);
      const queued = this.#database
        .prepare(
          `SELECT DISTINCT t.user_id
           FROM turns t JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
           WHERE t.state = 'queued' AND s.state = 'active'`,
        )
        .all() as unknown as Array<{ user_id: string }>;
      return queued.map(({ user_id }) => user_id);
    });
  }

  public stageArtifacts(
    userId: string,
    endpointId: string,
    artifacts: readonly RuntimeArtifact[],
    now: number,
  ): { expired: RuntimeArtifact[] } {
    return transaction(this.#database, () => {
      const expired = this.#expireStagedArtifacts(userId, now);
      if (artifacts.length === 0) return { expired };
      if (
        artifacts.length > MAX_STAGED_ARTIFACTS ||
        artifacts.some((artifact) => artifact.userId !== userId) ||
        artifacts.reduce((total, artifact) => total + artifact.bytes, 0) >
          MAX_STAGED_TOTAL_BYTES
      ) {
        throw new AppError(
          "media-invalid",
          "staged attachments exceed MVP limits",
        );
      }
      const existing = this.#database
        .prepare(
          "SELECT count(*) AS count FROM staged_artifacts WHERE user_id = ?",
        )
        .get(userId) as { count: bigint };
      if (Number(existing.count) + artifacts.length > MAX_STAGED_ARTIFACTS) {
        throw new AppError(
          "busy",
          "too many staged attachments; send text to start a Turn",
        );
      }
      const existingBytes = this.#database
        .prepare(
          "SELECT coalesce(sum(a.bytes), 0) AS bytes FROM staged_artifacts s JOIN artifacts a ON a.id = s.artifact_id AND a.user_id = s.user_id WHERE s.user_id = ?",
        )
        .get(userId) as { bytes: bigint };
      if (
        Number(existingBytes.bytes) +
          artifacts.reduce((total, artifact) => total + artifact.bytes, 0) >
        MAX_STAGED_TOTAL_BYTES
      ) {
        throw new AppError(
          "busy",
          "staged attachments would exceed the 40 MiB bound",
        );
      }
      let ordinal = Number(existing.count);
      for (const artifact of artifacts) {
        this.#insertArtifact(artifact, now);
        this.#database
          .prepare(
            `INSERT INTO staged_artifacts(user_id, artifact_id, ordinal, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(userId, artifact.id, ordinal, now);
        ordinal += 1;
      }
      this.#insertOutbox(
        userId,
        endpointId,
        null,
        `Saved ${artifacts.length} attachment(s); send text to start a Turn.`,
      );
      return { expired };
    });
  }

  public takeStagedArtifacts(
    userId: string,
    now: number,
  ): { artifacts: RuntimeArtifact[]; expired: RuntimeArtifact[] } {
    return transaction(this.#database, () => {
      const expired = this.#expireStagedArtifacts(userId, now);
      const rows = this.#database
        .prepare(
          `SELECT a.id, a.user_id AS userId, a.storage_key AS storageKey,
                  a.sha256, a.bytes, a.media_kind AS mediaKind,
                  a.mime_type AS mimeType, a.display_name AS displayName
           FROM staged_artifacts s
           JOIN artifacts a ON a.id = s.artifact_id AND a.user_id = s.user_id
           WHERE s.user_id = ?
           ORDER BY s.ordinal`,
        )
        .all(userId)
        .map((value) => {
          const artifact = value as Omit<RuntimeArtifact, "bytes"> & {
            bytes: bigint;
          };
          return { ...artifact, bytes: Number(artifact.bytes) };
        });
      this.#database
        .prepare("DELETE FROM staged_artifacts WHERE user_id = ?")
        .run(userId);
      return { artifacts: rows, expired };
    });
  }

  public enqueueSystemNotice(
    userId: string,
    endpointId: string,
    text: string,
  ): void {
    this.#insertOutbox(userId, endpointId, null, text);
  }

  public stagedArtifactCount(userId: string): number {
    const row = this.#database
      .prepare(
        "SELECT count(*) AS count FROM staged_artifacts WHERE user_id = ?",
      )
      .get(userId) as { count: bigint };
    return Number(row.count);
  }

  #expireStagedArtifacts(userId: string, now: number): RuntimeArtifact[] {
    const rows = this.#database
      .prepare(
        `SELECT a.id, a.user_id AS userId, a.storage_key AS storageKey,
                a.sha256, a.bytes, a.media_kind AS mediaKind,
                a.mime_type AS mimeType, a.display_name AS displayName
         FROM staged_artifacts s
         JOIN artifacts a ON a.id = s.artifact_id AND a.user_id = s.user_id
         WHERE s.user_id = ? AND s.created_at < ?`,
      )
      .all(userId, now - STAGED_TTL_MS)
      .map((value) => {
        const artifact = value as Omit<RuntimeArtifact, "bytes"> & {
          bytes: bigint;
        };
        return { ...artifact, bytes: Number(artifact.bytes) };
      });
    if (rows.length > 0) {
      this.#database
        .prepare(
          "DELETE FROM staged_artifacts WHERE user_id = ? AND created_at < ?",
        )
        .run(userId, now - STAGED_TTL_MS);
    }
    return rows;
  }

  public runningTurnEndpoints(accountId: string): readonly {
    turnId: string;
    endpointId: string;
    platformUserId: string;
    privateChatId: string | null;
    kind: "telegram" | "wechat" | "wecom";
  }[] {
    return this.#database
      .prepare(
        `SELECT t.id AS turnId, e.id AS endpointId,
                e.platform_user_id AS platformUserId,
                e.private_chat_id AS privateChatId, e.kind
         FROM turns t
         JOIN channel_endpoints e ON e.id = t.endpoint_id AND e.user_id = t.user_id
         WHERE e.account_id = ? AND e.enabled = 1 AND t.state = 'running'
         ORDER BY t.ordinal`,
      )
      .all(accountId) as unknown as {
      turnId: string;
      endpointId: string;
      platformUserId: string;
      privateChatId: string | null;
      kind: "telegram" | "wechat" | "wecom";
    }[];
  }

  public pendingTelegramOutbox(
    accountId: string,
    limit = 16,
  ): readonly OutboxDelivery[] {
    return this.#pendingOutbox("telegram", accountId, limit);
  }

  #pendingOutbox(
    channel: "telegram" | "wechat" | "wecom",
    accountId: string,
    limit: number,
  ): readonly OutboxDelivery[] {
    return this.#database
      .prepare(
        `SELECT o.id, o.user_id AS userId, e.account_id AS accountId,
                CASE WHEN e.kind = 'telegram' THEN e.private_chat_id
                     ELSE e.platform_user_id END AS privateChatId,
                o.kind, o.payload_text AS text,
                a.id AS artifactId, a.storage_key AS storageKey, a.sha256,
                a.bytes, a.media_kind AS mediaKind, a.mime_type AS mimeType,
                a.display_name AS displayName
         FROM outbox o
         JOIN channel_endpoints e ON e.id = o.endpoint_id AND e.user_id = o.user_id
         JOIN users u ON u.id = o.user_id
         LEFT JOIN artifacts a ON a.id = o.artifact_id AND a.user_id = o.user_id
         WHERE e.kind = ? AND e.account_id = ? AND e.enabled = 1 AND u.enabled = 1
           AND o.state IN ('pending', 'retryable') AND o.attempts < 5
         ORDER BY o.created_at, o.id LIMIT ?`,
      )
      .all(channel, accountId, limit)
      .map((value) => {
        const row = value as {
          id: string;
          userId: string;
          accountId: string;
          privateChatId: string;
          kind: "text" | "artifact";
          text: string | null;
          artifactId: string | null;
          storageKey: string | null;
          sha256: string | null;
          bytes: bigint | null;
          mediaKind: "image" | "file" | null;
          mimeType: string | null;
          displayName: string | null;
        };
        const common = {
          id: row.id,
          userId: row.userId,
          accountId: row.accountId,
          privateChatId: row.privateChatId,
          kind: row.kind,
        };
        if (row.kind === "text") {
          if (row.text === null)
            throw new AppError("internal-error", "text outbox row is invalid");
          return { ...common, text: row.text };
        }
        if (
          row.artifactId === null ||
          row.storageKey === null ||
          row.sha256 === null ||
          row.bytes === null ||
          row.mediaKind === null ||
          row.mimeType === null ||
          row.displayName === null
        ) {
          throw new AppError(
            "internal-error",
            "artifact outbox row is invalid",
          );
        }
        return {
          ...common,
          artifact: {
            id: row.artifactId,
            userId: row.userId,
            storageKey: row.storageKey,
            sha256: row.sha256,
            bytes: Number(row.bytes),
            mediaKind: row.mediaKind,
            mimeType: row.mimeType,
            displayName: row.displayName,
          },
        };
      });
  }

  public pendingWeChatOutbox(
    accountId: string,
    limit = 16,
  ): readonly OutboxDelivery[] {
    return this.#pendingOutbox("wechat", accountId, limit);
  }

  public pendingWeComOutbox(
    accountId: string,
    limit = 16,
  ): readonly OutboxDelivery[] {
    return this.#pendingOutbox("wecom", accountId, limit);
  }

  public claimOutbox(delivery: OutboxDelivery): boolean {
    const changed = this.#database
      .prepare(
        `UPDATE outbox SET state = 'sending', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND state IN ('pending', 'retryable')`,
      )
      .run(this.clock.now(), delivery.id, delivery.userId);
    return changed.changes === 1n;
  }

  public markOutboxSent(delivery: OutboxDelivery): void {
    this.#database
      .prepare(
        "UPDATE outbox SET state = 'sent', updated_at = ? WHERE id = ? AND user_id = ? AND state = 'sending'",
      )
      .run(this.clock.now(), delivery.id, delivery.userId);
  }

  public markOutboxRetryable(delivery: OutboxDelivery): void {
    this.#database
      .prepare(
        `UPDATE outbox SET state = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'retryable' END, updated_at = ?
         WHERE id = ? AND user_id = ? AND state = 'sending'`,
      )
      .run(this.clock.now(), delivery.id, delivery.userId);
  }

  public markOutboxFailed(delivery: OutboxDelivery, _reason: string): void {
    this.#database
      .prepare(
        "UPDATE outbox SET state = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND state = 'sending'",
      )
      .run(this.clock.now(), delivery.id, delivery.userId);
  }

  public count(
    table: "sessions" | "turns" | "outbox" | "artifacts",
    userId?: string,
  ): number {
    const row =
      userId === undefined
        ? (this.#database
            .prepare(`SELECT count(*) AS count FROM ${table}`)
            .get() as { count: bigint })
        : (this.#database
            .prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id = ?`)
            .get(userId) as {
            count: bigint;
          });
    return Number(row.count);
  }
}
