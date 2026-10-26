import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  MessageType,
  type Message,
  type ClientOptions,
} from "discord.js";
import { AppError } from "../app/errors.js";
import {
  MediaStore,
  MAX_INPUT_ARTIFACTS,
  MAX_INPUT_ARTIFACT_BYTES,
  MAX_INPUT_TOTAL_BYTES,
} from "../media/media-store.js";
import type { RuntimeArtifact } from "../runtime/runtime.js";
import type { DiscordAttachment } from "./discord-ingress.js";
import type { HitchApplication, IngressResult } from "../app/application.js";
import type { HitchStore, OutboxDelivery } from "../app/store.js";
import {
  classifyDiscordMessage,
  DISCORD_MESSAGE_CONTENT_UNAVAILABLE,
  type DiscordMessage,
} from "./discord-ingress.js";

// Capture Node's platform fetch while this static module graph is evaluated.
// main.ts later replaces globalThis.fetch for WeChat; discord.js REST's nested
// Undici dispatcher is incompatible with the root Undici dispatcher in that
// import graph. Discord REST must use this captured platform implementation.
const discordPlatformFetch: typeof fetch = globalThis.fetch;
export const discordRestMakeRequest = ((url: string, init: unknown) =>
  discordPlatformFetch(url, init as RequestInit)) as unknown as NonNullable<
  NonNullable<ClientOptions["rest"]>["makeRequest"]
>;

export type { DiscordMessage } from "./discord-ingress.js";
export type DiscordOutboxDelivery = OutboxDelivery;
export type DiscordIngressResult = IngressResult;
export type DiscordStore = Pick<
  HitchStore,
  | "resolveDiscordEndpoint"
  | "pendingDiscordOutbox"
  | "claimOutbox"
  | "markOutboxSent"
  | "markOutboxRetryable"
  | "markOutboxFailed"
  | "runningTurnEndpoints"
> &
  Partial<
    Pick<
      HitchStore,
      | "discordRichReplyGroup"
      | "pendingDiscordRichReplyCandidates"
      | "claimDiscordOutboxGroup"
      | "markDiscordOutboxGroupSent"
      | "markDiscordOutboxGroupRetryable"
    >
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
  downloadAttachment(
    attachment: DiscordAttachment,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  sendArtifact(
    channelId: string,
    artifact: RuntimeArtifact,
    media: MediaStore,
    options?: DiscordSendOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  sendRichReply?(
    channelId: string,
    text: string,
    artifacts: readonly RuntimeArtifact[],
    media: MediaStore,
    options?: DiscordSendOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  sendTyping(channelId: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export type DiscordFailurePhase =
  | "artifact-size"
  | "artifact-verify"
  | "channel-fetch"
  | "destination-check"
  | "upload";

export type DiscordFailureKind =
  | "timeout"
  | "aborted"
  | "http"
  | "network"
  | "other";
export type DiscordTransportCode =
  | "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH"
  | "UND_ERR_CONNECT_TIMEOUT"
  | "UND_ERR_ABORTED"
  | "UND_ERR_SOCKET"
  | "ECONNRESET"
  | "ECONNREFUSED"
  | "ETIMEDOUT"
  | "EPIPE"
  | "ENOTFOUND"
  | "EAI_AGAIN"
  | "ENETUNREACH";

export interface DiscordFailureDiagnostic {
  readonly phase: DiscordFailurePhase;
  readonly kind?: DiscordFailureKind;
  readonly status?: number;
  readonly code?: number;
  readonly transportCode?: DiscordTransportCode;
}

const DISCORD_TRANSPORT_CODES = new Set<DiscordTransportCode>([
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
]);

function ownDataProperty(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, name)?.value;
  } catch {
    return undefined;
  }
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth <= 2; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    chain.push(current);
    current = ownDataProperty(current, "cause");
  }
  return chain;
}

function safeNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

export function discordFailureDiagnostic(
  error: unknown,
): DiscordFailureDiagnostic | undefined {
  if (!(error instanceof DiscordTransportError) || error.phase === undefined)
    return undefined;
  return {
    phase: error.phase,
    ...(error.kind === undefined ? {} : { kind: error.kind }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.transportCode === undefined
      ? {}
      : { transportCode: error.transportCode }),
  };
}

class DiscordOperationInterruption extends Error {
  public constructor(readonly kind: "timeout" | "aborted") {
    super("Discord operation interrupted");
    this.name = "DiscordOperationInterruption";
  }
}

export class DiscordTransportError extends Error {
  public readonly phase?: DiscordFailurePhase;
  public readonly kind?: DiscordFailureKind;
  public readonly status?: number;
  public readonly code?: number;
  public readonly transportCode?: DiscordTransportCode;

  public constructor(message: string, diagnostic?: DiscordFailureDiagnostic) {
    super(message);
    this.name = "DiscordTransportError";
    if (diagnostic !== undefined) {
      this.phase = diagnostic.phase;
      if (diagnostic.kind !== undefined) this.kind = diagnostic.kind;
      if (diagnostic.status !== undefined) this.status = diagnostic.status;
      if (diagnostic.code !== undefined) this.code = diagnostic.code;
      if (diagnostic.transportCode !== undefined)
        this.transportCode = diagnostic.transportCode;
    }
  }

  public static artifactFailure(
    phase: DiscordFailurePhase,
    error: unknown,
  ): DiscordTransportError {
    const chain = errorChain(error);
    let kind: DiscordFailureKind = "other";
    let status: number | undefined;
    let code: number | undefined;
    let transportCode: DiscordTransportCode | undefined;
    for (const item of chain) {
      if (item instanceof DiscordOperationInterruption) kind = item.kind;
      const candidateStatus = safeNumber(
        ownDataProperty(item, "status"),
        100,
        599,
      );
      const candidateCode = safeNumber(
        ownDataProperty(item, "code"),
        0,
        Number.MAX_SAFE_INTEGER,
      );
      if (status === undefined && candidateStatus !== undefined)
        status = candidateStatus;
      if (code === undefined && candidateCode !== undefined)
        code = candidateCode;
      const rawTransportCode = ownDataProperty(item, "code");
      if (
        typeof rawTransportCode === "string" &&
        DISCORD_TRANSPORT_CODES.has(rawTransportCode as DiscordTransportCode)
      ) {
        transportCode = rawTransportCode as DiscordTransportCode;
        if (
          transportCode === "ETIMEDOUT" ||
          transportCode === "UND_ERR_CONNECT_TIMEOUT"
        )
          kind = "timeout";
        else if (transportCode === "UND_ERR_ABORTED") kind = "aborted";
        else kind = "network";
      }
    }
    if (status !== undefined) kind = "http";
    return new DiscordTransportError("Discord artifact delivery failed", {
      phase,
      kind,
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(transportCode === undefined ? {} : { transportCode }),
    });
  }
}
export const DISCORD_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
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
    throw new DiscordOperationInterruption("aborted");
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        const timeout = (): void =>
          reject(new DiscordOperationInterruption("timeout"));
        const aborted = (): void =>
          reject(new DiscordOperationInterruption("aborted"));
        timer = setTimeout(timeout, 30_000);
        onAbort = aborted;
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
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
    attachments: [...message.attachments.values()].map((file) => ({
      url: file.url,
      name: file.name,
      size: file.size,
      ...(file.contentType === null ? {} : { contentType: file.contentType }),
    })),
  };
}
export interface DiscordDownloadOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}
/** Pinned discord.js owns heartbeat, resume and REST rate-limit buckets. */
export class DiscordJsClient implements DiscordClient {
  readonly #token: string;
  readonly #client: Client;
  readonly #downloadFetcher: typeof fetch;
  readonly #downloadTimeoutMs: number;
  #onMessage: ((message: DiscordMessage) => void) | null = null;
  #invalidated = false;
  public constructor(
    token: string,
    messageContent = false,
    client?: Client,
    downloadOptions: DiscordDownloadOptions = {},
  ) {
    if (token.length === 0)
      throw new DiscordTransportError("Discord token is unavailable");
    this.#token = token;
    this.#downloadFetcher = downloadOptions.fetcher ?? fetch;
    this.#downloadTimeoutMs = downloadOptions.timeoutMs ?? 30_000;
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
        rest: {
          timeout: 15_000,
          makeRequest: discordRestMakeRequest,
        },
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
  public async downloadAttachment(
    attachment: DiscordAttachment,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    abortCheck(signal);
    try {
      const url = new URL(attachment.url);
      if (
        url.protocol !== "https:" ||
        !["cdn.discordapp.com", "media.discordapp.net"].includes(
          url.hostname,
        ) ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error("invalid CDN URL");
      return this.#downloadBody(url, signal);
    } catch {
      throw new AppError("media-invalid", "Discord attachment download failed");
    }
  }
  /** Resource lifetime includes body streaming, not only receipt of headers.
   * Deferred setup also means an iterable never consumed has nothing to leak. */
  async *#downloadBody(
    url: URL,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    // Unlike weakly composed timeout signals, this timer strongly holds its controller.
    const timer = setTimeout(() => controller.abort(), this.#downloadTimeoutMs);
    timer.unref();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    let complete = false;
    try {
      controller.signal.throwIfAborted();
      const response = await this.#downloadFetcher(url, {
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || response.body === null)
        throw new Error("download failed");
      for await (const chunk of response.body as ReadableStream<Uint8Array> &
        AsyncIterable<Uint8Array>) {
        controller.signal.throwIfAborted();
        yield chunk;
      }
      controller.signal.throwIfAborted();
      complete = true;
    } catch {
      throw new AppError("media-invalid", "Discord attachment download failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
      if (!complete) controller.abort();
    }
  }
  public async sendArtifact(
    channelId: string,
    artifact: RuntimeArtifact,
    media: MediaStore,
    options: DiscordSendOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    let phase: DiscordFailurePhase = "artifact-size";
    try {
      if (signal?.aborted) throw new DiscordOperationInterruption("aborted");
      this.assertHealthy();
      if (artifact.bytes > DISCORD_UPLOAD_LIMIT_BYTES)
        throw new Error("oversize");
      phase = "artifact-verify";
      const path = media.verifiedObjectPath(artifact);
      phase = "channel-fetch";
      const channel = await bounded(
        this.#client.channels.fetch(channelId),
        signal,
      );
      if (signal?.aborted) throw new DiscordOperationInterruption("aborted");
      phase = "destination-check";
      if (
        channel === null ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.DM)
      )
        throw new Error("unsupported destination");
      phase = "upload";
      await bounded<unknown>(
        channel.send({
          files: [new AttachmentBuilder(path, { name: artifact.displayName })],
          allowedMentions: { parse: [], repliedUser: false },
          ...(options.replyToMessageId === undefined
            ? {}
            : {
                reply: {
                  messageReference: options.replyToMessageId,
                  failIfNotExists: false,
                },
              }),
        }),
        signal,
      );
      if (signal?.aborted) throw new DiscordOperationInterruption("aborted");
    } catch (error) {
      throw DiscordTransportError.artifactFailure(phase, error);
    }
  }
  public async sendRichReply(
    channelId: string,
    text: string,
    artifacts: readonly RuntimeArtifact[],
    media: MediaStore,
    options: DiscordSendOptions = {},
    signal?: AbortSignal,
  ): Promise<void> {
    let phase: DiscordFailurePhase = "artifact-verify";
    try {
      abortCheck(signal);
      this.assertHealthy();
      if (
        !text ||
        text.length > MAX_TEXT_UNITS ||
        artifacts.length === 0 ||
        artifacts.length > 8 ||
        artifacts.some((item) => item.bytes > DISCORD_UPLOAD_LIMIT_BYTES) ||
        artifacts.reduce((sum, item) => sum + item.bytes, 0) >
          DISCORD_UPLOAD_LIMIT_BYTES
      )
        throw new Error("rich reply limits exceeded");
      const files = artifacts.map((artifact) => {
        if (artifact.bytes < 0) throw new Error("invalid artifact size");
        return new AttachmentBuilder(media.verifiedObjectPath(artifact), {
          name: artifact.displayName,
        });
      });
      phase = "channel-fetch";
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
      phase = "upload";
      await bounded<unknown>(
        channel.send({
          content: text,
          files,
          allowedMentions: { parse: [], repliedUser: false },
          ...(options.replyToMessageId === undefined
            ? {}
            : {
                reply: {
                  messageReference: options.replyToMessageId,
                  failIfNotExists: false,
                },
              }),
        }),
        signal,
      );
      abortCheck(signal);
    } catch (error) {
      throw DiscordTransportError.artifactFailure(phase, error);
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
  readonly media?: MediaStore;
  readonly logger?: (message: string) => void;
  readonly typingIntervalMs?: number;
  readonly reconnectDelayMs?: number;
}
export class DiscordWorker {
  readonly #client: DiscordClient;
  readonly #media: MediaStore | undefined;
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
    this.#media = options.media;
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
    if (!ingress.hasAttachments && ingress.text.length === 0) {
      await this.#safeSend(
        message.channelId,
        DISCORD_MESSAGE_CONTENT_UNAVAILABLE,
        { replyToMessageId: ingress.source.messageId },
        signal,
      );
      return;
    }
    const artifacts: RuntimeArtifact[] = [];
    let result: IngressResult;
    try {
      if (ingress.hasAttachments) {
        const files = normalized.attachments ?? [];
        const endpoint = this.store.resolveDiscordEndpoint(
          this.account.id,
          ingress.mode,
          ingress.scopeId,
          ingress.channelId,
        );
        if (endpoint === null || this.#media === undefined)
          throw new AppError("media-invalid", "media storage is unavailable");
        if (
          files.length === 0 ||
          files.length > MAX_INPUT_ARTIFACTS ||
          files.some(
            (file) =>
              !Number.isSafeInteger(file.size) ||
              file.size < 1 ||
              file.size > MAX_INPUT_ARTIFACT_BYTES,
          ) ||
          files.reduce((sum, file) => sum + file.size, 0) >
            MAX_INPUT_TOTAL_BYTES
        )
          throw new AppError(
            "media-invalid",
            "Discord attachments exceed MVP limits (8 files, 20 MiB each, 40 MiB total)",
          );
        for (const file of files) {
          const source = await this.#client.downloadAttachment(file, signal);
          artifacts.push(
            await this.#media.ingest(endpoint.userId, source, {
              advertisedBytes: file.size,
              ...(file.contentType === undefined
                ? {}
                : { advertisedMime: file.contentType }),
              displayName: file.name,
              expectImage: file.contentType?.startsWith("image/") ?? false,
            }),
          );
        }
      }
      abortCheck(signal);
      result = this.application.receiveDiscord(
        this.account.id,
        botId,
        normalized,
        artifacts,
      );
      if (!result.accepted || result.duplicate)
        for (const artifact of artifacts) this.#media?.discard(artifact);
    } catch (error) {
      for (const artifact of artifacts) this.#media?.discard(artifact);
      result = {
        accepted: false,
        duplicate: false,
        category: error instanceof AppError ? error.category : "media-invalid",
        message:
          error instanceof AppError
            ? error.message
            : "Discord attachment intake failed",
      };
    }
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
    const consumed = new Set<string>();
    const page = this.store.pendingDiscordOutbox(this.account.id, 20);
    const candidates =
      this.store.pendingDiscordRichReplyCandidates?.(this.account.id) ?? [];
    for (const delivery of [...page, ...candidates]) {
      if (signal?.aborted) break;
      if (consumed.has(delivery.id)) continue;
      const group = this.store.discordRichReplyGroup?.(delivery);
      const textRow = group?.find((row) => row.kind === "text");
      const files = group?.filter((row) => row.kind === "artifact") ?? [];
      const text = textRow?.text;
      const fitsRichLimits =
        group !== null &&
        group !== undefined &&
        textRow !== undefined &&
        text !== undefined &&
        text.length > 0 &&
        text.length <= MAX_TEXT_UNITS &&
        files.length > 0 &&
        files.length <= 8 &&
        files.every(
          (row) =>
            row.artifact !== undefined &&
            row.artifact.userId === row.userId &&
            row.artifact.bytes <= DISCORD_UPLOAD_LIMIT_BYTES,
        ) &&
        files.reduce((sum, row) => sum + (row.artifact?.bytes ?? 0), 0) <=
          DISCORD_UPLOAD_LIMIT_BYTES;
      const canRichSend =
        fitsRichLimits &&
        this.#client.sendRichReply !== undefined &&
        this.#media !== undefined &&
        this.store.claimDiscordOutboxGroup !== undefined;
      if (canRichSend) {
        if (!this.store.claimDiscordOutboxGroup!(group)) continue;
        group.forEach((row) => consumed.add(row.id));
        try {
          const source = textRow.discordSource;
          await this.#client.sendRichReply!(
            delivery.privateChatId,
            text!,
            files.map((row) => row.artifact!),
            this.#media!,
            source === undefined ? {} : { replyToMessageId: source.messageId },
            signal,
          );
          abortCheck(signal);
          if (this.store.markDiscordOutboxGroupSent?.(group))
            sent += group.length;
        } catch (error) {
          this.store.markDiscordOutboxGroupRetryable?.(group);
          const diagnostic = discordFailureDiagnostic(error);
          this.#log(
            diagnostic === undefined
              ? "delivery failed; outbox retry retained"
              : `delivery failed; outbox retry retained; phase=${diagnostic.phase}${diagnostic.kind === undefined ? "" : ` kind=${diagnostic.kind}`}${diagnostic.status === undefined ? "" : ` status=${diagnostic.status}`}${diagnostic.code === undefined ? "" : ` code=${diagnostic.code}`}${diagnostic.transportCode === undefined ? "" : ` transport=${diagnostic.transportCode}`}`,
          );
        }
        continue;
      }
      consumed.add(delivery.id);
      if (!this.store.claimOutbox(delivery)) continue;
      try {
        const options =
          delivery.discordSource === undefined
            ? {}
            : { replyToMessageId: delivery.discordSource.messageId };
        if (
          delivery.kind === "artifact" &&
          delivery.artifact !== undefined &&
          this.#media !== undefined
        ) {
          const artifact = delivery.artifact;
          if (artifact.userId !== delivery.userId)
            throw new DiscordTransportError("artifact owner mismatch");
          if (artifact.bytes > DISCORD_UPLOAD_LIMIT_BYTES) {
            this.store.markOutboxFailed(
              delivery,
              "discord-artifact-too-large",
              `File "${artifact.displayName}" is too large for Discord: ${artifact.bytes} bytes (limit ${DISCORD_UPLOAD_LIMIT_BYTES} bytes / 10 MiB).`,
            );
            continue;
          }
          await this.#client.sendArtifact(
            delivery.privateChatId,
            artifact,
            this.#media,
            options,
            signal,
          );
        } else if (delivery.kind === "text" && delivery.text !== undefined) {
          await this.#client.sendText(
            delivery.privateChatId,
            delivery.text,
            options,
            signal,
          );
        } else {
          throw new DiscordTransportError("artifact delivery is unavailable");
        }
        abortCheck(signal);
        this.store.markOutboxSent(delivery);
        sent += 1;
      } catch (error) {
        this.store.markOutboxRetryable(delivery);
        const diagnostic = discordFailureDiagnostic(error);
        this.#log(
          diagnostic === undefined
            ? "delivery failed; outbox retry retained"
            : `delivery failed; outbox retry retained; phase=${diagnostic.phase}${diagnostic.kind === undefined ? "" : ` kind=${diagnostic.kind}`}${diagnostic.status === undefined ? "" : ` status=${diagnostic.status}`}${diagnostic.code === undefined ? "" : ` code=${diagnostic.code}`}${diagnostic.transportCode === undefined ? "" : ` transport=${diagnostic.transportCode}`}`,
        );
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
