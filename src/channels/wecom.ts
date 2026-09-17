import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";

import WebSocket from "ws";

import type { HitchApplication, IngressResult } from "../app/application.js";
import type { HitchStore, OutboxDelivery } from "../app/store.js";

const WECOM_URL = "wss://openws.work.weixin.qq.com";
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_TEXT_CHUNK = 3_000;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export interface WebSocketLike {
  send(data: string): void;
  ping(): void;
  terminate(): void;
  on(
    event: "open" | "message" | "error" | "close" | "pong",
    listener: (...args: unknown[]) => void,
  ): this;
  once(
    event: "open" | "error" | "close",
    listener: (...args: unknown[]) => void,
  ): this;
}

export interface WeComCredentials {
  readonly botId: string;
  readonly secret: string;
}

export class WeComError extends Error {
  public constructor(
    message: string,
    readonly fatal = false,
  ) {
    super(message);
    this.name = "WeComError";
  }
}

interface Frame {
  readonly headers: { readonly req_id: string };
  readonly body?: unknown;
  readonly cmd?: unknown;
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
}

interface Pending {
  readonly resolve: (frame: Frame) => void;
  readonly reject: (error: WeComError) => void;
}

export interface WeComClientOptions {
  readonly botId: string;
  readonly secret: string;
  readonly socketFactory?: (
    url: string,
    options: { maxPayload: number; perMessageDeflate: boolean },
  ) => WebSocketLike;
  readonly heartbeatMs?: number;
  readonly ackTimeoutMs?: number;
  readonly sendGapMs?: number;
  readonly pingMs?: number;
  readonly livenessLimitMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function frame(value: unknown): Frame | null {
  const parsed = record(value);
  const headers = record(parsed?.headers);
  return typeof headers?.req_id === "string"
    ? { headers: { req_id: headers.req_id }, ...parsed }
    : null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortWait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function readWeComCredentials(path: string): WeComCredentials {
  try {
    const canonical = realpathSync(path);
    const metadata = lstatSync(canonical, { bigint: true });
    const uid = process.getuid?.();
    if (
      canonical !== path ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      metadata.size > BigInt(MAX_CREDENTIAL_BYTES) ||
      (uid !== undefined && metadata.uid !== BigInt(uid)) ||
      (metadata.mode & 0o777n) !== 0o600n
    ) {
      throw new Error();
    }
    const parsed = record(JSON.parse(readFileSync(canonical, "utf8")));
    if (
      parsed === null ||
      Object.keys(parsed).length !== 2 ||
      !Object.hasOwn(parsed, "botId") ||
      !Object.hasOwn(parsed, "secret")
    ) {
      throw new Error();
    }
    for (const value of [parsed.botId, parsed.secret]) {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        Buffer.byteLength(value, "utf8") > 8192 ||
        CONTROL_PATTERN.test(value) ||
        /^(?:placeholder|replace[-_ ]?me|changeme|null|undefined)$/iu.test(
          value,
        )
      ) {
        throw new Error();
      }
    }
    return { botId: parsed.botId as string, secret: parsed.secret as string };
  } catch {
    throw new WeComError("WeCom credentials are invalid", true);
  }
}

export class WeComClient {
  readonly #socketFactory: NonNullable<WeComClientOptions["socketFactory"]>;
  readonly #heartbeatMs: number;
  readonly #ackTimeoutMs: number;
  readonly #sendGapMs: number;
  readonly #pingMs: number;
  readonly #livenessLimitMs: number;
  readonly #pending = new Map<string, Pending>();
  #socket: WebSocketLike | undefined;
  #stopped = false;
  #dead = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  #lastLiveness = 0;
  #sendChain: Promise<void> = Promise.resolve();
  #lastSendAt = 0;
  public onMessage: (frame: unknown) => void = () => undefined;
  public onDead: (error: WeComError) => void = () => undefined;

  public constructor(readonly options: WeComClientOptions) {
    this.#socketFactory =
      options.socketFactory ??
      ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
    this.#sendGapMs = options.sendGapMs ?? 2_100;
    this.#pingMs = options.pingMs ?? 10_000;
    this.#livenessLimitMs = options.livenessLimitMs ?? 25_000;
  }

  #clearTimers(): void {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (this.#ping !== undefined) clearInterval(this.#ping);
    this.#ping = undefined;
  }

  #die(error: WeComError): void {
    if (this.#dead || this.#stopped) return;
    this.#dead = true;
    this.#clearTimers();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.onDead(error);
  }

  #request(cmd: string, body: unknown): Promise<Frame> {
    const socket = this.#socket;
    if (socket === undefined || this.#dead || this.#stopped)
      return Promise.reject(new WeComError("WeCom connection is unavailable"));
    const reqId = randomUUID();
    return new Promise<Frame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#pending.delete(reqId))
          reject(new WeComError("WeCom request timed out"));
      }, this.#ackTimeoutMs);
      this.#pending.set(reqId, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        socket.send(JSON.stringify({ headers: { req_id: reqId }, cmd, body }));
      } catch {
        this.#pending.delete(reqId);
        clearTimeout(timeout);
        const error = new WeComError("WeCom transport failed");
        reject(error);
        this.#die(error);
      }
    });
  }

  #receive(data: unknown): void {
    this.#lastLiveness = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
      );
    } catch {
      process.stderr.write("WeCom received a malformed frame\n");
      return;
    }
    const incoming = frame(parsed);
    if (incoming === null) {
      process.stderr.write("WeCom received an invalid frame\n");
      return;
    }
    const pending = this.#pending.get(incoming.headers.req_id);
    if (pending !== undefined && incoming.cmd === undefined) {
      this.#pending.delete(incoming.headers.req_id);
      pending.resolve(incoming);
      return;
    }
    if (incoming.cmd === "aibot_heartbeat") return;
    this.onMessage(parsed);
  }

  #ackSucceeded(response: Frame, operation: string): void {
    if (typeof response.errcode !== "number")
      throw new WeComError(`${operation} acknowledgement is invalid`);
    if (response.errcode !== 0) {
      throw new WeComError(
        `${operation} was rejected`,
        operation === "WeCom subscription",
      );
    }
  }

  async #heartbeatOnce(): Promise<void> {
    try {
      this.#ackSucceeded(
        await this.#request("aibot_heartbeat", {}),
        "WeCom heartbeat",
      );
    } catch {
      this.#die(new WeComError("WeCom heartbeat failed"));
    }
  }

  public async connect(): Promise<void> {
    if (this.#stopped) throw new WeComError("WeCom client is stopped");
    const socket = this.#socketFactory(WECOM_URL, {
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => reject(new WeComError("WeCom transport failed"));
      socket.once("open", () => resolve());
      socket.once("error", fail);
      socket.once("close", fail);
    });
    socket.on("message", (data) => this.#receive(data));
    socket.on("pong", () => {
      this.#lastLiveness = Date.now();
    });
    socket.on("error", () =>
      this.#die(new WeComError("WeCom transport failed")),
    );
    socket.on("close", () =>
      this.#die(new WeComError("WeCom connection closed")),
    );
    try {
      this.#ackSucceeded(
        await this.#request("aibot_subscribe", {
          bot_id: this.options.botId,
          secret: this.options.secret,
        }),
        "WeCom subscription",
      );
    } catch (error) {
      this.stop();
      throw error;
    }
    this.#lastLiveness = Date.now();
    this.#heartbeat = setInterval(
      () => void this.#heartbeatOnce(),
      this.#heartbeatMs,
    );
    this.#ping = setInterval(() => {
      if (
        this.#lastLiveness > 0 &&
        Date.now() - this.#lastLiveness > this.#livenessLimitMs
      ) {
        this.#die(new WeComError("WeCom connection is unresponsive"));
        return;
      }
      try {
        this.#socket?.ping();
      } catch {
        this.#die(new WeComError("WeCom transport failed"));
      }
    }, this.#pingMs);
  }

  public async sendText(userId: string, text: string): Promise<void> {
    for (let index = 0; index < text.length; index += MAX_TEXT_CHUNK) {
      const content = text.slice(index, index + MAX_TEXT_CHUNK);
      const send = async (): Promise<void> => {
        const remaining = this.#sendGapMs - (Date.now() - this.#lastSendAt);
        if (remaining > 0) await wait(remaining);
        this.#lastSendAt = Date.now();
        const response = await this.#request("aibot_send_msg", {
          chat_type: 1,
          chatid: userId,
          msgtype: "markdown",
          markdown: { content },
        });
        this.#ackSucceeded(response, "WeCom message");
      };
      const queued = this.#sendChain.then(send, send);
      this.#sendChain = queued.catch(() => undefined);
      await queued;
    }
  }

  public stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearTimers();
    for (const pending of this.#pending.values())
      pending.reject(new WeComError("WeCom client stopped"));
    this.#pending.clear();
    try {
      this.#socket?.terminate();
    } catch {
      // Local socket teardown is best effort.
    }
  }
}

export interface WeComWorkerOptions {
  readonly socketFactory?: WeComClientOptions["socketFactory"];
  readonly heartbeatMs?: number;
  readonly ackTimeoutMs?: number;
  readonly deliverPollMs?: number;
  readonly sendGapMs?: number;
  readonly reconnectBaseMs?: number;
  readonly pingMs?: number;
  readonly livenessLimitMs?: number;
}

export class WeComWorker {
  readonly #credentials: WeComCredentials;
  readonly #options: Required<Omit<WeComWorkerOptions, "socketFactory">> &
    Pick<WeComWorkerOptions, "socketFactory">;

  public constructor(
    readonly accountId: string,
    credentialsFile: string,
    readonly application: HitchApplication,
    readonly store: HitchStore,
    options: WeComWorkerOptions = {},
  ) {
    this.#credentials = readWeComCredentials(credentialsFile);
    this.#options = {
      socketFactory: options.socketFactory,
      heartbeatMs: options.heartbeatMs ?? 30_000,
      ackTimeoutMs: options.ackTimeoutMs ?? 10_000,
      deliverPollMs: options.deliverPollMs ?? 1_000,
      sendGapMs: options.sendGapMs ?? 2_100,
      reconnectBaseMs: options.reconnectBaseMs ?? 1_000,
      pingMs: options.pingMs ?? 10_000,
      livenessLimitMs: options.livenessLimitMs ?? 25_000,
    };
  }

  async #deliver(client: WeComClient, delivery: OutboxDelivery): Promise<void> {
    if (!this.store.claimOutbox(delivery)) return;
    if (delivery.kind === "artifact") {
      this.store.markOutboxFailed(
        delivery,
        "internal-error: WeCom artifact delivery is not supported yet",
      );
      return;
    }
    try {
      if (delivery.kind !== "text" || delivery.text === undefined)
        throw new WeComError("WeCom outbox row is invalid");
      await client.sendText(delivery.privateChatId, delivery.text);
      this.store.markOutboxSent(delivery);
    } catch (error) {
      this.store.markOutboxRetryable(delivery);
      throw error;
    }
  }

  async #deliverOnce(client: WeComClient): Promise<void> {
    for (const delivery of this.store.pendingWeComOutbox(this.accountId))
      await this.#deliver(client, delivery);
  }

  async #handle(client: WeComClient, incoming: unknown): Promise<void> {
    const parsed = record(incoming);
    if (parsed?.cmd === "aibot_event_callback") {
      const event = record(record(parsed.body)?.event);
      if (event?.eventtype === "disconnected_event")
        throw new WeComError("WeCom connection was displaced", true);
      return;
    }
    if (parsed?.cmd !== "aibot_msg_callback") return;
    const result: IngressResult = this.application.receiveWeCom(
      this.accountId,
      incoming,
      this.#credentials.botId,
    );
    if (
      !result.accepted &&
      !result.duplicate &&
      result.replyPeerId !== undefined
    )
      await client.sendText(
        result.replyPeerId,
        `${result.category ?? "rejected"}: ${result.message ?? "message rejected"}`,
      );
  }

  public async run(signal?: AbortSignal): Promise<void> {
    const activeSignal = signal ?? new AbortController().signal;
    const stopped = abortWait(activeSignal);
    let delay = this.#options.reconnectBaseMs;
    while (!activeSignal.aborted) {
      let client: WeComClient | undefined;
      let fail: (error: WeComError) => void = () => undefined;
      let lostReason = "WeCom connection lost";
      const dead = new Promise<WeComError>((resolve) => {
        fail = resolve;
      });
      const connectionStop = new AbortController();
      const connectionStopped = abortWait(connectionStop.signal);
      try {
        client = new WeComClient({
          ...this.#credentials,
          ...(this.#options.socketFactory === undefined
            ? {}
            : { socketFactory: this.#options.socketFactory }),
          heartbeatMs: this.#options.heartbeatMs,
          ackTimeoutMs: this.#options.ackTimeoutMs,
          sendGapMs: this.#options.sendGapMs,
          pingMs: this.#options.pingMs,
          livenessLimitMs: this.#options.livenessLimitMs,
        });
        client.onDead = fail;
        client.onMessage = (incoming) => {
          void this.#handle(client as WeComClient, incoming).catch(
            (error: unknown) => {
              fail(
                error instanceof WeComError
                  ? error
                  : new WeComError("WeCom inbound handling failed"),
              );
            },
          );
        };
        await client.connect();
        process.stderr.write(`WeCom connected (account ${this.accountId})\n`);
        const connected: WeComClient = client;
        delay = this.#options.reconnectBaseMs;
        const delivery = (async (): Promise<void> => {
          while (!activeSignal.aborted && !connectionStop.signal.aborted) {
            await this.#deliverOnce(connected);
            await Promise.race([
              wait(this.#options.deliverPollMs),
              stopped,
              connectionStopped,
            ]);
          }
        })();
        void delivery.catch((error: unknown) => {
          fail(
            error instanceof WeComError
              ? error
              : new WeComError("WeCom delivery failed"),
          );
        });
        const error = await Promise.race([dead, stopped.then(() => undefined)]);
        connectionStop.abort();
        client.stop();
        await delivery.catch(() => undefined);
        if (error === undefined || activeSignal.aborted) return;
        if (error.fatal) throw error;
        lostReason = error.message;
      } catch (error) {
        connectionStop.abort();
        client?.stop();
        if (activeSignal.aborted) return;
        if (!(error instanceof WeComError) || error.fatal) {
          process.stderr.write(
            `WeCom fatal (account ${this.accountId}): ${error instanceof Error ? error.message : "unknown"}\n`,
          );
          throw error;
        }
        lostReason = error.message;
      }
      process.stderr.write(
        `WeCom reconnecting (account ${this.accountId}): ${lostReason}; retry in ${delay}ms\n`,
      );
      await Promise.race([wait(delay), stopped]);
      delay = Math.min(delay * 2, 60_000);
    }
  }
}
