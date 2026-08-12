import type { HitchApplication } from "../app/application.js";
import type { HitchStore, OutboxDelivery } from "../app/store.js";

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
    method: "getUpdates" | "sendMessage",
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
  public constructor(
    readonly accountId: string,
    readonly bot: TelegramBotClient,
    readonly application: HitchApplication,
    readonly store: HitchStore,
  ) {}

  public async pollOnce(signal?: AbortSignal): Promise<number> {
    let offset = this.store.getTelegramOffset(this.accountId);
    const updates = await this.bot.getUpdates(offset, signal);
    let handled = 0;
    for (const update of updates) {
      const updateId = stableUpdateId(update);
      if (updateId === null || updateId < offset) continue;
      const result = this.application.receiveTelegram(this.accountId, update);
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
      await this.bot.sendText(delivery.privateChatId, delivery.text, signal);
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

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
      } catch (error) {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        if (!(error instanceof TelegramError)) throw error;
      }
    }
  }
}
