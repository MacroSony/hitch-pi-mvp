import type { AgentRuntime, RuntimeResult } from "../runtime/runtime.js";
import {
  classifyTelegramIdentity,
  readTelegramContent,
} from "../channels/telegram-ingress.js";
import { parseCommand } from "./commands.js";
import { AppError, type FailureCategory } from "./errors.js";
import { HitchStore, type MessageIdentity } from "./store.js";

export interface IngressResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly category?: FailureCategory;
  readonly message?: string;
  readonly updateId?: number;
  readonly replyPrivateChatId?: string;
}

export class HitchApplication {
  readonly #controllers = new Map<string, AbortController>();
  readonly #pumps = new Map<string, Promise<void>>();
  #started = false;
  #stopping = false;

  public constructor(
    readonly store: HitchStore,
    readonly runtime: AgentRuntime,
  ) {}

  public start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const userId of this.store.recoverAfterRestart())
      this.#schedule(userId);
  }

  public receiveTelegram(accountId: string, update: unknown): IngressResult {
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
      const content = readTelegramContent(ingress);
      const identity: MessageIdentity = {
        endpoint,
        idempotencyKey: ingress.idempotencyKey,
        contentDigest: content.contentDigest,
      };
      const command = parseCommand(content.text);
      if (command === null) {
        const admitted = this.store.admitPrompt(identity, content.text);
        this.#schedule(admitted.userId);
        return { accepted: true, duplicate: admitted.duplicate, updateId };
      }
      const result = this.store.executeCommand(
        identity,
        command,
        content.text,
        this.runtime.models ?? [],
      );
      if (result.abortTurnId !== null)
        this.#controllers.get(result.abortTurnId)?.abort();
      return { accepted: true, duplicate: result.duplicate, updateId };
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
      let result: RuntimeResult;
      try {
        result = await this.runtime.run(turn, controller.signal);
      } catch {
        result = {
          outcome: "unknown",
          text: "",
          sessionReusable: false,
        };
      } finally {
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
