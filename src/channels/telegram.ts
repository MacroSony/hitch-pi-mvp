import { openAsBlob } from "node:fs";

import { AppError } from "../app/errors.js";
import type { HitchApplication } from "../app/application.js";
import type { HitchStore, OutboxDelivery } from "../app/store.js";
import {
  classifyTelegramIdentity,
  readTelegramMediaDescriptor,
} from "./telegram-ingress.js";
import { MediaStore } from "../media/media-store.js";
import type { RuntimeArtifact } from "../runtime/runtime.js";

const TELEGRAM_TEXT_CHUNK = 4_000;

export class TelegramError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

interface TelegramEnvelope {
  readonly ok?: unknown;
  readonly result?: unknown;
}

export class TelegramBotClient {
  public constructor(
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
  ) {
    if (token.length === 0)
      throw new TelegramError("Telegram bot token is empty");
  }

  async #call(
    method: "getUpdates" | "sendMessage" | "getFile" | "sendChatAction",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch {
      throw new TelegramError("Telegram transport failed");
    }
    if (!response.ok) throw new TelegramError("Telegram request failed");
    let envelope: TelegramEnvelope;
    try {
      envelope = (await response.json()) as TelegramEnvelope;
    } catch {
      throw new TelegramError("Telegram returned an invalid response");
    }
    if (envelope.ok !== true)
      throw new TelegramError("Telegram rejected the request");
    return envelope.result;
  }

  public async getUpdates(
    offset: number,
    signal?: AbortSignal,
  ): Promise<readonly unknown[]> {
    const result = await this.#call(
      "getUpdates",
      { offset, timeout: 5, limit: 50, allowed_updates: ["message"] },
      signal,
    );
    if (!Array.isArray(result))
      throw new TelegramError("Telegram update response is invalid");
    return result;
  }

  public async sendText(
    privateChatId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const characters = Array.from(text);
    for (
      let offset = 0;
      offset < characters.length;
      offset += TELEGRAM_TEXT_CHUNK
    ) {
      await this.#call(
        "sendMessage",
        {
          chat_id: privateChatId,
          text: characters.slice(offset, offset + TELEGRAM_TEXT_CHUNK).join(""),
        },
        signal,
      );
    }
  }

  public async getFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; bytes?: number }> {
    const result = await this.#call("getFile", { file_id: fileId }, signal);
    if (result === null || typeof result !== "object" || Array.isArray(result))
      throw new TelegramError("Telegram file response is invalid");
    const value = result as Record<string, unknown>;
    if (
      typeof value.file_path !== "string" ||
      value.file_path.length === 0 ||
      value.file_path.length > 512 ||
      value.file_path.startsWith("/") ||
      value.file_path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      /[\u0000-\u001f\u007f]/u.test(value.file_path)
    ) {
      throw new TelegramError("Telegram file path is invalid");
    }
    if (
      value.file_size !== undefined &&
      (!Number.isSafeInteger(value.file_size) || Number(value.file_size) < 0)
    ) {
      throw new TelegramError("Telegram file size is invalid");
    }
    return {
      path: value.file_path,
      ...(value.file_size === undefined
        ? {}
        : { bytes: Number(value.file_size) }),
    };
  }

  public async sendChatAction(
    privateChatId: string,
    action: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#call(
      "sendChatAction",
      { chat_id: privateChatId, action },
      signal,
    );
  }

  public async downloadFile(
    path: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/file/bot${this.token}/${path}`,
        signal === undefined ? {} : { signal },
      );
    } catch {
      throw new TelegramError("Telegram file transport failed");
    }
    if (!response.ok || response.body === null)
      throw new TelegramError("Telegram file download failed");
    return response;
  }

  public async sendArtifact(
    privateChatId: string,
    artifact: RuntimeArtifact,
    media: MediaStore,
    signal?: AbortSignal,
  ): Promise<void> {
    const field = artifact.mediaKind === "image" ? "photo" : "document";
    const method =
      artifact.mediaKind === "image" ? "sendPhoto" : "sendDocument";
    const form = new FormData();
    form.set("chat_id", privateChatId);
    form.set(
      field,
      await openAsBlob(media.verifiedObjectPath(artifact), {
        type: artifact.mimeType,
      }),
      artifact.displayName,
    );
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          body: form,
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch {
      throw new TelegramError("Telegram artifact transport failed");
    }
    if (!response.ok)
      throw new TelegramError("Telegram artifact request failed");
    let envelope: TelegramEnvelope;
    try {
      envelope = (await response.json()) as TelegramEnvelope;
    } catch {
      throw new TelegramError("Telegram returned an invalid artifact response");
    }
    if (envelope.ok !== true)
      throw new TelegramError("Telegram rejected the artifact");
  }
}

function stableUpdateId(update: unknown): number | null {
  if (update === null || typeof update !== "object" || Array.isArray(update))
    return null;
  const value = (update as Record<string, unknown>).update_id;
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

export class TelegramWorker {
  readonly #typing = new Map<string, ReturnType<typeof setInterval>>();

  public constructor(
    readonly accountId: string,
    readonly bot: TelegramBotClient,
    readonly application: HitchApplication,
    readonly store: HitchStore,
    readonly media?: MediaStore,
  ) {}

  async #receive(
    update: unknown,
    signal?: AbortSignal,
  ): Promise<ReturnType<HitchApplication["receiveTelegram"]>> {
    const identity = classifyTelegramIdentity(update);
    const endpoint = this.store.resolveTelegramEndpoint(
      this.accountId,
      identity.platformUserId,
      identity.privateChatId,
    );
    if (endpoint === null)
      return this.application.receiveTelegram(this.accountId, update);
    const artifacts: RuntimeArtifact[] = [];
    try {
      const descriptor = readTelegramMediaDescriptor(identity);
      if (descriptor === null)
        return this.application.receiveTelegram(this.accountId, update);
      if (this.media === undefined)
        throw new AppError("media-invalid", "media storage is unavailable");
      const remote = await this.bot.getFile(descriptor.fileId, signal);
      if (
        descriptor.advertisedBytes !== undefined &&
        remote.bytes !== undefined &&
        descriptor.advertisedBytes !== remote.bytes
      ) {
        throw new AppError("media-invalid", "Telegram media size changed");
      }
      const response = await this.bot.downloadFile(remote.path, signal);
      const artifact = await this.media.ingest(
        endpoint.userId,
        response.body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
        {
          ...((descriptor.advertisedBytes ?? remote.bytes) === undefined
            ? {}
            : {
                advertisedBytes: descriptor.advertisedBytes ?? remote.bytes,
              }),
          ...(descriptor.advertisedMime === undefined
            ? {}
            : { advertisedMime: descriptor.advertisedMime }),
          displayName: descriptor.displayName,
          expectImage: descriptor.expectImage,
        },
      );
      artifacts.push(artifact);
      const result = this.application.receiveTelegram(
        this.accountId,
        update,
        artifacts,
      );
      if (!result.accepted || result.duplicate)
        for (const value of artifacts) this.media.discard(value);
      return result;
    } catch (error) {
      for (const value of artifacts) this.media?.discard(value);
      if (error instanceof AppError)
        return {
          accepted: false,
          duplicate: false,
          category: error.category,
          message: error.message,
          updateId: identity.updateId,
          replyPrivateChatId: endpoint.privateChatId,
        };
      throw error;
    }
  }

  public async pollOnce(signal?: AbortSignal): Promise<number> {
    let offset = this.store.getTelegramOffset(this.accountId);
    const updates = await this.bot.getUpdates(offset, signal);
    let handled = 0;
    for (const update of updates) {
      const updateId = stableUpdateId(update);
      if (updateId === null || updateId < offset) continue;
      let result: ReturnType<HitchApplication["receiveTelegram"]>;
      try {
        result = await this.#receive(update, signal);
      } catch (error) {
        if (error instanceof AppError) {
          result = {
            accepted: false,
            duplicate: false,
            category: error.category,
            message: error.message,
            updateId,
          };
        } else {
          throw error;
        }
      }
      offset = updateId + 1;
      this.store.setTelegramOffset(this.accountId, offset);
      handled += 1;
      if (!result.accepted && result.replyPrivateChatId !== undefined) {
        await this.bot.sendText(
          result.replyPrivateChatId,
          `${result.category ?? "rejected"}: ${result.message ?? "message rejected"}`,
          signal,
        );
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.deliverOnce(signal);
    return handled;
  }

  async #deliver(
    delivery: OutboxDelivery,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.store.claimOutbox(delivery)) return;
    try {
      if (delivery.kind === "text" && delivery.text !== undefined) {
        await this.bot.sendText(delivery.privateChatId, delivery.text, signal);
      } else if (
        delivery.kind === "artifact" &&
        delivery.artifact !== undefined &&
        this.media !== undefined
      ) {
        await this.bot.sendArtifact(
          delivery.privateChatId,
          delivery.artifact,
          this.media,
          signal,
        );
      } else {
        throw new TelegramError("artifact delivery is unavailable");
      }
      this.store.markOutboxSent(delivery);
    } catch (error) {
      this.store.markOutboxRetryable(delivery);
      throw error;
    }
  }

  public async deliverOnce(signal?: AbortSignal): Promise<number> {
    const deliveries = this.store.pendingTelegramOutbox(this.accountId);
    let sent = 0;
    for (const delivery of deliveries) {
      await this.#deliver(delivery, signal);
      sent += 1;
    }
    return sent;
  }

  async #refreshTyping(signal?: AbortSignal): Promise<void> {
    const running = this.store.runningTurnEndpoints(this.accountId);
    const active = new Set(running.map(({ turnId }) => turnId));
    for (const [turnId, timer] of this.#typing) {
      if (active.has(turnId)) continue;
      clearInterval(timer);
      this.#typing.delete(turnId);
    }
    for (const row of running) {
      if (row.kind !== "telegram" || row.privateChatId === null) continue;
      if (this.#typing.has(row.turnId)) continue;
      const chatId = row.privateChatId;
      const send = (): void => {
        void this.bot.sendChatAction(chatId, "typing").catch(() => undefined);
      };
      try {
        await this.bot.sendChatAction(chatId, "typing", signal);
      } catch {
        continue;
      }
      this.#typing.set(row.turnId, setInterval(send, 5_000));
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        try {
          await this.pollOnce(signal);
          await this.#refreshTyping(signal);
        } catch (error) {
          if (signal.aborted) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
          if (!(error instanceof TelegramError)) throw error;
        }
      }
    } finally {
      for (const timer of this.#typing.values()) clearInterval(timer);
      this.#typing.clear();
    }
  }
}
