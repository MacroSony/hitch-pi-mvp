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
import { parseCommand } from "./commands.js";
import { AppError, type FailureCategory } from "./errors.js";
import {
  HitchStore,
  type EndpointContext,
  type MessageIdentity,
} from "./store.js";

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
  #started = false;
  #stopping = false;

  public constructor(
    readonly store: HitchStore,
    readonly runtime: AgentRuntime,
    readonly mediaMode: MediaMode = "always-trigger",
    readonly media?: MediaStore,
  ) {}

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
