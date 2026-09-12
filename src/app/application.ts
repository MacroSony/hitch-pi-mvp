import { join } from "node:path";
import type {
  AgentRuntime,
  RuntimeArtifact,
  RuntimeResult,
} from "../runtime/runtime.js";
import {
  classifyTelegramIdentity,
  readTelegramContent,
} from "../channels/telegram-ingress.js";
import type { MediaMode } from "../config/config.js";
import type { MediaStore } from "../media/media-store.js";
import {
  classifyWeChatIdentity,
  readWeChatContent,
} from "../channels/wechat-ingress.js";
import { parseCommand, type WakeCommand } from "./commands.js";
import { AppError, type FailureCategory } from "./errors.js";
import {
  HitchStore,
  type ClaimedTurn,
  type EndpointContext,
  type MessageIdentity,
} from "./store.js";
import { WakeStore } from "../wake/store.js";
import type { WakeRecurrence } from "../wake/types.js";
import { nextFireAfter } from "../wake/next-fire.js";

const PROGRESS_FLUSH_MS = 30_000;
const PROGRESS_MAX_CHARS_PER_MESSAGE = 4000;
const PROGRESS_MAX_BYTES_PER_TURN = 64 * 1024;

const WEEKDAY_TOKENS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function formatRecurrenceSummary(
  recurrence: WakeRecurrence,
  timeOfDay: string,
  tz: string,
): string {
  switch (recurrence.kind) {
    case "daily":
      return `daily ${timeOfDay} (${tz})`;
    case "weekly":
      return `weekly ${recurrence.weekdays.map((d) => WEEKDAY_TOKENS[d] ?? String(d)).join(",")} ${timeOfDay} (${tz})`;
    case "once":
      return `once ${recurrence.date} ${timeOfDay} (${tz})`;
  }
}

function formatNextFireTime(utcMs: number, timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return formatter.format(new Date(utcMs)).replace(", ", " ");
  } catch {
    return new Date(utcMs).toISOString();
  }
}

function truncatePrompt(prompt: string, maxChars = 40): string {
  const singleLine = prompt.replace(/\r?\n/gu, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 3)}...`;
}

class TurnProgress {
  readonly #store: HitchStore;
  readonly #turn: ClaimedTurn;
  readonly #flushMs: number;
  #buffer = "";
  #sentBytes = 0;
  #closed = false;
  #timer: NodeJS.Timeout | null = null;

  public constructor(store: HitchStore, turn: ClaimedTurn, flushMs: number) {
    this.#store = store;
    this.#turn = turn;
    this.#flushMs = flushMs;
  }

  public push(delta: string): void {
    if (this.#closed || delta.length === 0) return;
    this.#buffer += delta;
    if (this.#timer === null) {
      this.#timer = setTimeout(() => this.flush(), this.#flushMs);
      this.#timer.unref?.();
    }
  }

  public flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#closed || this.#buffer.length === 0) return;
    const characters = Array.from(this.#buffer);
    const text =
      characters.length <= PROGRESS_MAX_CHARS_PER_MESSAGE
        ? this.#buffer
        : characters.slice(0, PROGRESS_MAX_CHARS_PER_MESSAGE).join("");
    this.#buffer = "";
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.#sentBytes + bytes > PROGRESS_MAX_BYTES_PER_TURN) {
      this.#closed = true;
      return;
    }
    this.#sentBytes += bytes;
    try {
      this.#store.insertTurnProgress(this.#turn, text);
    } catch (error) {
      // Progress is best-effort: a failed progress row must never rerun or
      // quarantine the Turn, so it stays out of the pump's error path.
      process.stderr.write(
        `Turn progress insert failed: ${error instanceof Error ? error.message : "unknown"}\n`,
      );
    }
    if (this.#sentBytes >= PROGRESS_MAX_BYTES_PER_TURN) this.#closed = true;
  }

  public close(): void {
    this.#closed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

export interface IngressResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly category?: FailureCategory;
  readonly message?: string;
  readonly updateId?: number;
  readonly replyPrivateChatId?: string;
  readonly replyPeerId?: string;
}

export class HitchApplication {
  readonly #controllers = new Map<string, AbortController>();
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #wakeStores = new Map<string, WakeStore>();
  #started = false;
  #stopping = false;

  public constructor(
    readonly store: HitchStore,
    readonly runtime: AgentRuntime,
    readonly mediaMode: MediaMode = "always-trigger",
    readonly media?: MediaStore,
    readonly progressFlushMs: number = PROGRESS_FLUSH_MS,
    readonly userStateDir?: string | ((userId: string) => string),
    readonly wakeStoreFactory?: (userId: string) => WakeStore,
  ) {}

  #resolveUserStateDir(userId: string): string {
    if (typeof this.userStateDir === "function") {
      return this.userStateDir(userId);
    }
    if (typeof this.userStateDir === "string") {
      return join(this.userStateDir, userId);
    }
    throw new AppError(
      "rejected",
      "wake schedules are not configured on this installation",
    );
  }

  #getWakeStore(userId: string): WakeStore {
    let store = this.#wakeStores.get(userId);
    if (store === undefined) {
      if (this.wakeStoreFactory !== undefined) {
        store = this.wakeStoreFactory(userId);
      } else {
        const userDir = this.#resolveUserStateDir(userId);
        const filePath = join(userDir, "schedules.json");
        store = new WakeStore(filePath);
      }
      this.#wakeStores.set(userId, store);
    }
    return store;
  }

  public handleWakeCommand(
    identity: MessageIdentity,
    command: WakeCommand,
    channel: "telegram" | "wechat",
    sessionId: string,
  ): string {
    const userId = identity.endpoint.userId;
    let wakeStore: WakeStore;
    try {
      wakeStore = this.#getWakeStore(userId);
      wakeStore.reloadIfChanged();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown store error";
      return `Wake store error: ${message}`;
    }

    try {
      switch (command.action) {
        case "list": {
          if (wakeStore.fileError !== null) {
            return `Failed to read schedules: ${wakeStore.fileError}. Please check schedules.json.`;
          }
          const schedules = wakeStore.list(userId);
          if (schedules.length === 0) {
            return "No wake schedules configured.";
          }
          const now = Date.now();
          const lines = schedules.map((schedule) => {
            const status = schedule.enabled ? "enabled" : "paused";
            const summary = formatRecurrenceSummary(
              schedule.recurrence,
              schedule.timeOfDay,
              schedule.timezone,
            );
            const nextMs = nextFireAfter(schedule, now);
            const nextStr =
              nextMs !== null
                ? formatNextFireTime(nextMs, schedule.timezone)
                : "none";
            const promptPreview = truncatePrompt(schedule.promptTemplate);
            return `- [${schedule.id}] (${status}) ${summary} | next: ${nextStr} | "${promptPreview}"`;
          });
          return lines.join("\n");
        }
        case "add": {
          const defaultTz = wakeStore.getDefaultTimezone(userId);
          const tz = command.tz ?? defaultTz ?? "UTC";
          const schedule = wakeStore.add({
            ownerId: userId,
            channel,
            endpointId: identity.endpoint.id,
            sessionId,
            promptTemplate: command.prompt,
            timezone: tz,
            timeOfDay: command.timeOfDay,
            recurrence: command.recurrence,
            enabled: true,
            maxFires: null,
            until: null,
          });
          const summary = formatRecurrenceSummary(
            schedule.recurrence,
            schedule.timeOfDay,
            schedule.timezone,
          );
          return `Created wake schedule ${schedule.id} (${summary}).`;
        }
        case "del": {
          const removed = wakeStore.remove(command.id);
          if (!removed) {
            return `Schedule ${command.id} not found.`;
          }
          return `Deleted schedule ${command.id}.`;
        }
        case "pause": {
          const updated = wakeStore.setEnabled(command.id, false);
          if (!updated) {
            return `Schedule ${command.id} not found.`;
          }
          return `Paused schedule ${command.id}.`;
        }
        case "resume": {
          const updated = wakeStore.setEnabled(command.id, true);
          if (!updated) {
            return `Schedule ${command.id} not found.`;
          }
          return `Resumed schedule ${command.id}.`;
        }
        case "tz": {
          wakeStore.setDefaultTimezone(userId, command.tz);
          return `Default timezone set to ${command.tz}.`;
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message =
        error instanceof Error ? error.message : "unknown store error";
      return `Wake command failed: ${message}`;
    }
  }

  public start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const userId of this.store.recoverAfterRestart())
      this.#schedule(userId);
  }

  public receiveTelegram(
    accountId: string,
    update: unknown,
    artifacts: readonly RuntimeArtifact[] = [],
  ): IngressResult {
    let updateId: number | undefined;
    let replyPrivateChatId: string | undefined;
    try {
      if (this.#stopping)
        throw new AppError("busy", "Hitch is stopping; try again shortly");
      const ingress = classifyTelegramIdentity(update);
      updateId = ingress.updateId;
      const endpoint = this.store.resolveTelegramEndpoint(
        accountId,
        ingress.platformUserId,
        ingress.privateChatId,
      );
      if (endpoint === null)
        throw new AppError(
          "rejected",
          "Telegram private endpoint is not configured",
        );
      replyPrivateChatId = endpoint.privateChatId;
      if (artifacts.some((artifact) => artifact.userId !== endpoint.userId))
        throw new AppError("rejected", "Telegram media owner does not match");
      const effective = [...this.#takeStaged(endpoint.userId), ...artifacts];
      const content = readTelegramContent(ingress, effective);
      if (
        this.mediaMode === "text-trigger" &&
        effective.length > 0 &&
        !content.textProvided
      ) {
        this.#stage(endpoint, effective);
        return { accepted: true, duplicate: false, updateId };
      }
      return {
        ...this.#receiveAuthorized(
          endpoint,
          ingress.idempotencyKey,
          content.text,
          content.contentDigest,
          effective,
          "telegram",
        ),
        updateId,
      };
    } catch (error) {
      if (error instanceof AppError) {
        return {
          accepted: false,
          duplicate: false,
          category: error.category,
          message: error.message,
          ...(updateId === undefined ? {} : { updateId }),
          ...(replyPrivateChatId === undefined ? {} : { replyPrivateChatId }),
        };
      }
      process.stderr.write(
        `Telegram admission internal error: ${error instanceof Error ? error.message : "unknown"}\n`,
      );
      return {
        accepted: false,
        duplicate: false,
        category: "internal-error",
        message: "internal-error: Telegram message could not be admitted",
        ...(updateId === undefined ? {} : { updateId }),
        ...(replyPrivateChatId === undefined ? {} : { replyPrivateChatId }),
      };
    }
  }

  public receiveWeChat(
    accountId: string,
    authenticatedAccountId: string,
    message: unknown,
    artifacts: readonly RuntimeArtifact[] = [],
  ): IngressResult {
    let replyPeerId: string | undefined;
    try {
      if (this.#stopping)
        throw new AppError("busy", "Hitch is stopping; try again shortly");
      const ingress = classifyWeChatIdentity(authenticatedAccountId, message);
      const endpoint = this.store.resolveWeChatEndpoint(
        accountId,
        ingress.platformUserId,
      );
      if (endpoint === null)
        throw new AppError(
          "rejected",
          "WeChat private endpoint is not configured",
        );
      replyPeerId = endpoint.platformUserId;
      if (artifacts.some((artifact) => artifact.userId !== endpoint.userId))
        throw new AppError("rejected", "WeChat media owner does not match");
      const effective = [...this.#takeStaged(endpoint.userId), ...artifacts];
      const content = readWeChatContent(ingress, effective);
      if (
        this.mediaMode === "text-trigger" &&
        effective.length > 0 &&
        !content.textProvided
      ) {
        this.#stage(endpoint, effective);
        return { accepted: true, duplicate: false, replyPeerId };
      }
      return {
        ...this.#receiveAuthorized(
          endpoint,
          ingress.idempotencyKey,
          content.text,
          content.contentDigest,
          effective,
          "wechat",
        ),
        replyPeerId,
      };
    } catch (error) {
      if (error instanceof AppError) {
        return {
          accepted: false,
          duplicate: false,
          category: error.category,
          message: error.message,
          ...(replyPeerId === undefined ? {} : { replyPeerId }),
        };
      }
      process.stderr.write(
        `WeChat admission internal error: ${error instanceof Error ? error.message : "unknown"}\n`,
      );
      return {
        accepted: false,
        duplicate: false,
        category: "internal-error",
        message: "internal-error: WeChat message could not be admitted",
        ...(replyPeerId === undefined ? {} : { replyPeerId }),
      };
    }
  }

  #takeStaged(userId: string): RuntimeArtifact[] {
    if (this.mediaMode !== "text-trigger") return [];
    const { artifacts, expired } = this.store.takeStagedArtifacts(
      userId,
      this.store.clock.now(),
    );
    for (const artifact of expired) this.media?.discard(artifact);
    return artifacts;
  }

  #stage(
    endpoint: EndpointContext,
    artifacts: readonly RuntimeArtifact[],
  ): void {
    const { expired } = this.store.stageArtifacts(
      endpoint.userId,
      endpoint.id,
      artifacts,
      this.store.clock.now(),
    );
    for (const artifact of expired) this.media?.discard(artifact);
  }

  #receiveAuthorized(
    endpoint: EndpointContext,
    idempotencyKey: string,
    text: string,
    contentDigest: string,
    artifacts: readonly RuntimeArtifact[],
    channel: "telegram" | "wechat" = "telegram",
  ): IngressResult {
    const identity: MessageIdentity = {
      endpoint,
      idempotencyKey,
      contentDigest,
    };
    const command = parseCommand(text);
    if (command === null) {
      const admitted = this.store.admitPrompt(identity, text, artifacts);
      this.#schedule(admitted.userId);
      return { accepted: true, duplicate: admitted.duplicate };
    }
    if (artifacts.length > 0)
      throw new AppError("rejected", "commands cannot include media");
    const result = this.store.executeCommand(
      identity,
      command,
      text,
      this.runtime.models ?? [],
      this.runtime.forge,
      command.kind === "wake"
        ? (idn, cmd, sessionId) =>
            this.handleWakeCommand(idn, cmd, channel, sessionId)
        : undefined,
    );
    if (result.abortTurnId !== null)
      this.#controllers.get(result.abortTurnId)?.abort();
    this.#schedule(result.userId);
    return { accepted: true, duplicate: result.duplicate };
  }

  #schedule(userId: string): void {
    if (this.#stopping || this.#pumps.has(userId)) return;
    const pump = Promise.resolve()
      .then(() => this.#pumpUser(userId))
      .finally(() => {
        this.#pumps.delete(userId);
        if (this.store.hasDispatchableTurn(userId)) this.#schedule(userId);
      });
    this.#pumps.set(userId, pump);
    void pump.catch(() => undefined);
  }

  async #pumpUser(userId: string): Promise<void> {
    for (;;) {
      if (this.#stopping) return;
      const turn = this.store.claimNextTurn(userId);
      if (turn === null) return;
      const controller = new AbortController();
      this.#controllers.set(turn.turnId, controller);
      const progress = new TurnProgress(this.store, turn, this.progressFlushMs);
      let result: RuntimeResult;
      try {
        result = await this.runtime.run(turn, controller.signal, (delta) =>
          progress.push(delta),
        );
      } catch {
        result = {
          outcome: "unknown",
          text: "",
          sessionReusable: false,
        };
      } finally {
        progress.close();
        this.#controllers.delete(turn.turnId);
      }
      this.store.completeTurn(turn, result);
    }
  }

  public async drain(): Promise<void> {
    while (this.#pumps.size > 0) await Promise.all([...this.#pumps.values()]);
  }

  public activeTurnIds(): readonly string[] {
    return [...this.#controllers.keys()];
  }

  public stop(): void {
    this.#stopping = true;
    for (const controller of this.#controllers.values()) controller.abort();
  }
}
