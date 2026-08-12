import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Clock, FoundationDatabase } from "../foundation/database.js";
import type { RuntimeResult, RuntimeTurn } from "../runtime/runtime.js";
import type { Command } from "./commands.js";
import { AppError } from "./errors.js";

const MAX_SESSIONS_PER_USER = 32;
const MAX_ACTIVE_AND_QUEUED = 4;
const MAX_RESULT_BYTES = 64_000;

export interface IdSource {
  next(kind: "session" | "pi" | "turn" | "outbox"): string;
}

export const randomIds: IdSource = {
  next: (kind) => `${kind}_${randomUUID()}`,
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
  readonly text: string;
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
      return "agent-failed: the model Turn failed.";
    case "unknown":
      return "session-quarantined: the model Turn ended in an uncertain state.";
  }
}

export class HitchStore {
  readonly #database: DatabaseSync;

  public constructor(
    foundation: FoundationDatabase,
    readonly ids: IdSource = randomIds,
    readonly clock: Clock = { now: () => Date.now() },
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

  public admitPrompt(
    identity: MessageIdentity,
    prompt: string,
  ): AdmissionResult {
    return transaction(this.#database, () => {
      const existing = this.#existingMessage(identity);
      if (existing !== null) return { ...existing, duplicate: true };
      const session = this.#ensurePromptSession(
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
      return { turnId, userId: identity.endpoint.userId, duplicate: false };
    });
  }

  #insertOutbox(
    userId: string,
    endpointId: string,
    turnId: string,
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

  public executeCommand(
    identity: MessageIdentity,
    command: Command,
    sourceText: string,
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
          response = `Session ${session.name} (${session.state}); active ${Number(counts.active ?? 0n)}; queued ${Number(counts.queued ?? 0n)}.`;
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
          `SELECT t.id, t.user_id, t.session_id, t.endpoint_id, t.prompt_text
           FROM turns t JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
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
          }
        | undefined;
      if (row === undefined) return null;
      const changed = this.#database
        .prepare(
          "UPDATE turns SET state = 'running', updated_at = ? WHERE id = ? AND user_id = ? AND state = 'queued'",
        )
        .run(this.clock.now(), row.id, userId);
      if (changed.changes !== 1n) return null;
      return {
        turnId: row.id,
        userId: row.user_id,
        sessionId: row.session_id,
        endpointId: row.endpoint_id,
        prompt: row.prompt_text,
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
      this.#insertOutbox(turn.userId, turn.endpointId, turn.turnId, text);
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

  public pendingTelegramOutbox(
    accountId: string,
    limit = 16,
  ): readonly OutboxDelivery[] {
    return this.#database
      .prepare(
        `SELECT o.id, o.user_id AS userId, e.account_id AS accountId,
                e.private_chat_id AS privateChatId, o.payload_text AS text
         FROM outbox o
         JOIN channel_endpoints e ON e.id = o.endpoint_id AND e.user_id = o.user_id
         JOIN users u ON u.id = o.user_id
         WHERE e.kind = 'telegram' AND e.account_id = ? AND e.enabled = 1 AND u.enabled = 1
           AND o.kind = 'text' AND o.state IN ('pending', 'retryable') AND o.attempts < 5
         ORDER BY o.created_at, o.id LIMIT ?`,
      )
      .all(accountId, limit) as unknown as OutboxDelivery[];
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

  public count(
    table: "sessions" | "turns" | "outbox",
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
