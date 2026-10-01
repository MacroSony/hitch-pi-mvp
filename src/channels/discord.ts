import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  MessageType,
  type Message,
} from "discord.js";
import type { HitchApplication, IngressResult } from "../app/application.js";
import type { HitchStore, OutboxDelivery } from "../app/store.js";
import {
  classifyDiscordMessage,
  DISCORD_MESSAGE_CONTENT_UNAVAILABLE,
  type DiscordMessage,
} from "./discord-ingress.js";
export type { DiscordMessage } from "./discord-ingress.js";
export type DiscordOutboxDelivery = OutboxDelivery;
export type DiscordIngressResult = IngressResult;
export type DiscordStore = Pick<
  HitchStore,
  | "pendingDiscordOutbox"
  | "claimOutbox"
  | "markOutboxSent"
  | "markOutboxRetryable"
  | "markOutboxFailed"
  | "runningTurnEndpoints"
>;
export type DiscordRouteApplication = Pick<
  HitchApplication,
  "discordRouteAllowed" | "receiveDiscord"
>;

export interface DiscordAccountConfig {
  readonly id: string;
  readonly botToken?: string;
  readonly messageContent?: boolean;
}
export interface DiscordSendOptions {
  readonly replyToMessageId?: string;
}
export interface DiscordClient {
  /** Authenticated identity from Gateway Ready, never guessed from a token. */
  readonly botUserId: string | null;
  /** Throws only when SDK automatic Gateway recovery has terminated. */
  assertHealthy(): void;
  connect(
    onMessage: (message: DiscordMessage) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  fetchReferencedAuthor(
    channelId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  sendText(
    channelId: string,
    text: string,
    options?: DiscordSendOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  sendTyping(channelId: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export class DiscordTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DiscordTransportError";
  }
}
const MAX_TEXT_UNITS = 2_000;
const MAX_CHUNKS = 16;
const TRUNCATION_NOTICE = "\n[…truncated…]";
function truncateChunk(value: string): string {
  let prefix = "";
  for (const char of value) {
    if (prefix.length + char.length > MAX_TEXT_UNITS - TRUNCATION_NOTICE.length)
      break;
    prefix += char;
  }
  return `${prefix}${TRUNCATION_NOTICE}`;
}
/** Discord counts UTF-16 units; never split a surrogate pair. */
export function splitDiscordText(text: string): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  for (const char of text) {
    if (current.length + char.length > MAX_TEXT_UNITS) {
      chunks.push(current);
      if (chunks.length === MAX_CHUNKS) {
        chunks[MAX_CHUNKS - 1] = truncateChunk(chunks[MAX_CHUNKS - 1] ?? "");
        return chunks;
      }
      current = char;
    } else current += char;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
function abortCheck(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DiscordTransportError("Discord operation cancelled");
}
/** Bound SDK operations including time spent waiting for a rate-limit bucket.
 * The underlying REST request may still complete after cancellation: outbox
 * remains retryable, never falsely marked sent. Exactly-once is not claimed. */
async function bounded<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    // The SDK promise was created before entering this helper. Consume a late
    // rejection even when cancellation won the race before listener setup.
    void operation.catch(() => undefined);
    abortCheck(signal);
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        const fail = (): void =>
          reject(new DiscordTransportError("Discord operation interrupted"));
        timer = setTimeout(fail, 30_000);
        onAbort = fail;
        signal?.addEventListener("abort", fail, { once: true });
        if (signal?.aborted) fail();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
export function normalizeDiscordMessage(message: Message): DiscordMessage {
  const supportedType =
    message.type === MessageType.Default || message.type === MessageType.Reply;
  const isDm = message.channel.type === ChannelType.DM;
  const isGuildText = message.channel.type === ChannelType.GuildText;
  const reference = message.reference;
  const sameChannelReply =
    reference?.messageId !== undefined &&
    (reference.channelId === undefined ||
      reference.channelId === message.channelId) &&
    (reference.guildId === undefined || reference.guildId === message.guildId);
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    channelType: !supportedType
      ? "unsupported"
      : isDm
        ? "dm"
        : isGuildText
          ? "guild-text"
          : "unsupported",
    author: {
      id: message.author.id,
      name:
        message.member?.displayName ??
        message.author.globalName ??
        message.author.username,
      bot: message.author.bot,
    },
    webhookId: message.webhookId,
    content: message.content,
    mentionsBot: message.mentions.users.has(message.client.user?.id ?? ""),
    ...(sameChannelReply ? { replyToMessageId: reference.messageId! } : {}),
    timestamp: message.createdAt.toISOString(),
    hasAttachments: message.attachments.size > 0,
  };
}
/** Pinned discord.js owns heartbeat, resume and REST rate-limit buckets. */
export class DiscordJsClient implements DiscordClient {
  readonly #token: string;
  readonly #client: Client;
  #onMessage: ((message: DiscordMessage) => void) | null = null;
  #invalidated = false;
  public constructor(token: string, messageContent = false, client?: Client) {
    if (token.length === 0)
      throw new DiscordTransportError("Discord token is unavailable");
    this.#token = token;
    this.#client =
      client ??
      new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          ...(messageContent ? [GatewayIntentBits.MessageContent] : []),
        ],
        partials: [Partials.Channel],
        allowedMentions: { parse: [], repliedUser: false },
        rest: { timeout: 15_000 },
      });
    // SDK error events must not crash the shared service or log credential-bearing objects.
    this.#client.on("error", () => undefined);
    this.#client.on("shardError", () => undefined);
    // In this pinned SDK shardDisconnect is emitted only for unrecoverable
    // close codes. Ordinary reconnect/resume remains SDK-owned.
    this.#client.on("shardDisconnect", () => {
      this.#invalidated = true;
    });
    this.#client.on("invalidated", () => {
      this.#invalidated = true;
    });
    this.#client.on("messageCreate", (message) => {
      try {
        this.#onMessage?.(normalizeDiscordMessage(message));
      } catch {
        /* drop malformed events */
      }
    });
  }
  public assertHealthy(): void {
    if (this.#invalidated)
      throw new DiscordTransportError("Discord Gateway requires reconnection");
  }
  public get botUserId(): string | null {
    return this.#client.user?.id ?? null;
  }
  public async connect(
    onMessage: (message: DiscordMessage) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    abortCheck(signal);
    this.#onMessage = onMessage;
    this.#invalidated = false;
    try {
      await bounded(this.#client.login(this.#token), signal);
      abortCheck(signal);
      if (this.botUserId === null) throw new Error("no authenticated identity");
      this.assertHealthy();
    } catch {
      throw new DiscordTransportError("Discord connection failed");
    }
  }
  public async fetchReferencedAuthor(
    channelId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    abortCheck(signal);
    this.assertHealthy();
    try {
      const channel = await bounded(
        this.#client.channels.fetch(channelId),
        signal,
      );
      abortCheck(signal);
      if (channel === null || channel.type !== ChannelType.GuildText)
        return null;
      const referenced = await bounded(
        channel.messages.fetch(messageId),
        signal,
      );
      return referenced.author.id;
    } catch {
      throw new DiscordTransportError("Discord reply lookup failed");
    }
  }
  public async sendText(
    channelId: string,
    text: string,
    options: DiscordSendOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    abortCheck(signal);
    this.assertHealthy();
    try {
      const chunks = splitDiscordText(text);
      if (chunks.length === 0) throw new Error("empty Discord message");
      const channel = await bounded(
        this.#client.channels.fetch(channelId),
        signal,
      );
      abortCheck(signal);
      if (
        channel === null ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.DM)
      )
        throw new Error("unsupported destination");
      for (let index = 0; index < chunks.length; index += 1) {
        abortCheck(signal);
        const reply =
          index === 0 && options.replyToMessageId !== undefined
            ? {
                messageReference: options.replyToMessageId,
                failIfNotExists: false,
              }
            : undefined;
        await bounded<unknown>(
          channel.send({
            content: chunks[index]!,
            allowedMentions: { parse: [], repliedUser: false },
            ...(reply === undefined ? {} : { reply }),
          }),
          signal,
        );
      }
      abortCheck(signal);
    } catch {
      throw new DiscordTransportError("Discord text delivery failed");
    }
  }
  public async sendTyping(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    abortCheck(signal);
    this.assertHealthy();
    try {
      const channel = await bounded(
        this.#client.channels.fetch(channelId),
        signal,
      );
      abortCheck(signal);
      if (
        channel !== null &&
        (channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.DM)
      )
        await bounded(channel.sendTyping(), signal);
    } catch {
      throw new DiscordTransportError("Discord typing failed");
    }
  }
  public async close(): Promise<void> {
    this.#onMessage = null;
    try {
      await this.#client.destroy();
    } catch {
      /* content-free shutdown */
    }
  }
}
export interface DiscordWorkerOptions {
  readonly client?: DiscordClient;
  readonly logger?: (message: string) => void;
  readonly typingIntervalMs?: number;
  readonly reconnectDelayMs?: number;
}
export class DiscordWorker {
  readonly #client: DiscordClient;
  readonly #logger: (message: string) => void;
  readonly #typingIntervalMs: number;
  readonly #reconnectDelayMs: number;
  readonly #typing = new Map<string, number>();
  readonly #typingInFlight = new Set<string>();
  #ingress: Promise<void> = Promise.resolve();
  #pendingIngress = 0;
  #delivery: Promise<number> | null = null;
  public constructor(
    readonly account: DiscordAccountConfig,
    readonly application: DiscordRouteApplication,
    readonly store: DiscordStore,
    options: DiscordWorkerOptions = {},
  ) {
    this.#client =
      options.client ??
      new DiscordJsClient(
        account.botToken ?? "",
        account.messageContent ?? false,
      );
    this.#logger = options.logger ?? (() => undefined);
    this.#typingIntervalMs = options.typingIntervalMs ?? 7_500;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  }
  #log(message: string): void {
    this.#logger(`discord: ${message}`);
  }
  async #handleMessage(
    message: DiscordMessage,
    signal: AbortSignal,
  ): Promise<void> {
    this.#client.assertHealthy();
    const botId = this.#client.botUserId;
    if (
      signal.aborted ||
      botId === null ||
      message.channelType === "unsupported" ||
      message.author.bot ||
      message.author.id === botId ||
      message.webhookId != null
    )
      return;
    const mode = message.channelType === "dm" ? "dm" : "server";
    const scope = mode === "dm" ? message.author.id : message.guildId;
    if (
      scope === null ||
      !this.application.discordRouteAllowed(
        this.account.id,
        mode,
        scope,
        message.channelId,
      )
    )
      return;
    let normalized = message;
    // At most one reference lookup, after authorization; never import channel history.
    if (
      mode === "server" &&
      !message.mentionsBot &&
      message.replyToMessageId !== undefined &&
      message.referencedAuthorId === undefined
    ) {
      const author = await this.#client.fetchReferencedAuthor(
        message.channelId,
        message.replyToMessageId,
        signal,
      );
      if (author === null || signal.aborted) return;
      normalized = { ...message, referencedAuthorId: author };
    }
    if (signal.aborted) return;
    const ingress = classifyDiscordMessage(botId, normalized);
    if (ingress === null) return;
    if (ingress.hasAttachments || ingress.text.length === 0) {
      await this.#safeSend(
        message.channelId,
        ingress.hasAttachments
          ? "Discord attachments are not supported in M1."
          : DISCORD_MESSAGE_CONTENT_UNAVAILABLE,
        { replyToMessageId: ingress.source.messageId },
        signal,
      );
      return;
    }
    const result = this.application.receiveDiscord(
      this.account.id,
      botId,
      normalized,
    );
    if (!result.accepted && result.message !== undefined)
      await this.#safeSend(
        message.channelId,
        `${result.category ?? "rejected"}: ${result.message}`,
        { replyToMessageId: ingress.source.messageId },
        signal,
      );
  }
  async #safeSend(
    channelId: string,
    text: string,
    options: DiscordSendOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    try {
      await this.#client.sendText(channelId, text, options, signal);
    } catch {
      this.#log("request failed");
    }
  }
  #track(message: DiscordMessage, signal: AbortSignal): void {
    if (signal.aborted) return;
    // Bound asynchronous reference lookups and preserve arrival order before admission.
    if (this.#pendingIngress >= 64) {
      this.#log("ingress busy; message dropped");
      return;
    }
    this.#pendingIngress += 1;
    this.#ingress = this.#ingress
      .then(() => this.#handleMessage(message, signal))
      .catch(() => this.#log("message handling failed"))
      .finally(() => {
        this.#pendingIngress -= 1;
      });
  }
  #refreshTyping(signal: AbortSignal): void {
    const active = new Set(
      this.store
        .runningTurnEndpoints(this.account.id)
        .filter((row) => row.kind === "discord" && row.privateChatId !== null)
        .map((row) => row.privateChatId!),
    );
    for (const channel of this.#typing.keys())
      if (!active.has(channel)) this.#typing.delete(channel);
    for (const channel of active) {
      if (
        this.#typingInFlight.has(channel) ||
        Date.now() - (this.#typing.get(channel) ?? 0) < this.#typingIntervalMs
      )
        continue;
      this.#typing.set(channel, Date.now());
      this.#typingInFlight.add(channel);
      void this.#client
        .sendTyping(channel, signal)
        .catch(() => undefined)
        .finally(() => this.#typingInFlight.delete(channel));
    }
  }
  public deliverPending(signal?: AbortSignal): Promise<number> {
    this.#delivery ??= this.#deliverPending(signal).finally(() => {
      this.#delivery = null;
    });
    return this.#delivery;
  }
  async #deliverPending(signal?: AbortSignal): Promise<number> {
    let sent = 0;
    for (const delivery of this.store.pendingDiscordOutbox(
      this.account.id,
      20,
    )) {
      if (signal?.aborted) break;
      if (!this.store.claimOutbox(delivery)) continue;
      try {
        if (delivery.kind !== "text" || delivery.text === undefined) {
          this.store.markOutboxFailed(
            delivery,
            "discord-artifacts-unsupported",
          );
          await this.#safeSend(
            delivery.privateChatId,
            "A file was produced, but Discord file delivery is not supported in M1.",
            {},
            signal,
          );
          continue;
        }
        await this.#client.sendText(
          delivery.privateChatId,
          delivery.text,
          delivery.discordSource === undefined
            ? {}
            : { replyToMessageId: delivery.discordSource.messageId },
          signal,
        );
        abortCheck(signal);
        this.store.markOutboxSent(delivery);
        sent += 1;
      } catch {
        this.store.markOutboxRetryable(delivery);
        this.#log("delivery failed; outbox retry retained");
      }
    }
    return sent;
  }
  public async run(signal: AbortSignal): Promise<void> {
    let delay = this.#reconnectDelayMs;
    try {
      while (!signal.aborted) {
        try {
          await this.#client.connect(
            (message) => this.#track(message, signal),
            signal,
          );
          const connectedAt = Date.now();
          while (!signal.aborted) {
            this.#client.assertHealthy();
            if (Date.now() - connectedAt >= 30_000)
              delay = this.#reconnectDelayMs;
            this.#refreshTyping(signal);
            await this.deliverPending(signal);
            await pause(500, signal);
          }
        } catch {
          if (signal.aborted) break;
          this.#log("connection unavailable; retrying independently");
          await this.#client.close();
          await pause(delay, signal);
          delay = Math.min(delay * 2, 30_000);
        }
      }
    } finally {
      await this.#client.close();
      await this.#ingress;
      this.#typing.clear();
    }
  }
}
