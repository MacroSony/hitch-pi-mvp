import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ApiClient,
  buildCdnDownloadUrl,
  parseAesKey,
  type GetUpdatesResp,
  type GetUploadUrlReq,
  type GetUploadUrlResp,
} from "wechat-ilink-client";

import type { HitchApplication, IngressResult } from "../app/application.js";
import { AppError } from "../app/errors.js";
import type { HitchStore, OutboxDelivery } from "../app/store.js";
import { MediaStore } from "../media/media-store.js";
import type { RuntimeArtifact } from "../runtime/runtime.js";
import {
  classifyWeChatIdentity,
  readWeChatMediaDescriptors,
  type WeChatMediaDescriptor,
} from "./wechat-ingress.js";
import { WeChatStateStore, type WeChatCredentials } from "./wechat-state.js";

const WECHAT_TEXT_CHUNK = 4_000;
const WECHAT_SEND_INTERVAL_MS = 4_000;
const MAX_WECHAT_MESSAGES = 50;
const MAX_CDN_QUERY_BYTES = 8 * 1024;
const MAX_API_RESPONSE_BYTES = 64 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export class WeChatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WeChatError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function paddedSize(bytes: number): number {
  return Math.ceil((bytes + 1) / 16) * 16;
}

function assertApiSuccess(value: unknown, operation: string): void {
  const response = record(value);
  if (response === null)
    throw new WeChatError(`${operation} response is invalid`);
  const ret = response.ret ?? 0;
  const errorCode = response.errcode ?? 0;
  if (
    !Number.isSafeInteger(ret) ||
    !Number.isSafeInteger(errorCode) ||
    ret !== 0 ||
    errorCode !== 0
  ) {
    throw new WeChatError(`${operation} was rejected`);
  }
}

function parseHttpsUrl(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_CDN_QUERY_BYTES ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new WeChatError(`${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WeChatError(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new WeChatError(`${label} is invalid`);
  }
  return url.toString();
}

interface WeChatRawApi {
  getUpdates(cursor: string, timeoutMs?: number): Promise<GetUpdatesResp>;
  getUploadUrl(request: GetUploadUrlReq): Promise<GetUploadUrlResp>;
}

function mediaReference(descriptor: WeChatMediaDescriptor): {
  readonly query: string;
  readonly key?: Buffer;
} {
  const item = descriptor.item;
  const mediaOwner =
    item.type === 2
      ? record(record(item.image_item)?.media)
      : item.type === 4
        ? record(record(item.file_item)?.media)
        : item.type === 5
          ? record(record(item.video_item)?.media)
          : null;
  if (mediaOwner === null)
    throw new AppError("media-invalid", "WeChat media reference is missing");
  const query = mediaOwner.encrypt_query_param;
  if (
    typeof query !== "string" ||
    query.length === 0 ||
    Buffer.byteLength(query, "utf8") > MAX_CDN_QUERY_BYTES ||
    CONTROL_PATTERN.test(query)
  ) {
    throw new AppError("media-invalid", "WeChat CDN reference is invalid");
  }
  try {
    if (item.type === 2) {
      const hex = record(item.image_item)?.aeskey;
      if (hex !== undefined) {
        if (typeof hex !== "string" || !/^[a-fA-F0-9]{32}$/u.test(hex))
          throw new Error("invalid image AES key");
        return { query, key: Buffer.from(hex, "hex") };
      }
      const base64 = mediaOwner.aes_key;
      return typeof base64 === "string"
        ? { query, key: parseAesKey(base64) }
        : { query };
    }
    if (typeof mediaOwner.aes_key !== "string")
      throw new Error("missing AES key");
    return { query, key: parseAesKey(mediaOwner.aes_key) };
  } catch {
    throw new AppError("media-invalid", "WeChat media AES key is invalid");
  }
}

async function* bodyChunks(
  body: ReadableStream<Uint8Array>,
  limit: number,
): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  let observed = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      observed += chunk.value.byteLength;
      if (observed > limit)
        throw new AppError(
          "media-invalid",
          "WeChat encrypted media exceeds its advertised size",
        );
      yield Buffer.from(chunk.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response may already be closed.
    }
    reader.releaseLock();
  }
}

export interface WeChatRawClient {
  getUpdates(cursor: string): Promise<GetUpdatesResp>;
  download(
    descriptor: WeChatMediaDescriptor,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  sendText(peerId: string, text: string, contextToken: string): Promise<void>;
  sendArtifact(
    peerId: string,
    artifact: RuntimeArtifact,
    media: MediaStore,
    contextToken: string,
  ): Promise<void>;
}

export class WeChatIlinkClient implements WeChatRawClient {
  readonly #api: WeChatRawApi;
  #lastSendAt = 0;

  public constructor(
    readonly credentials: WeChatCredentials,
    readonly fetcher: typeof fetch = fetch,
    api?: WeChatRawApi,
  ) {
    this.#api =
      api ??
      new ApiClient({
        token: credentials.token,
        baseUrl: credentials.baseUrl,
        cdnBaseUrl: credentials.cdnBaseUrl,
      });
  }

  public async getUpdates(cursor: string): Promise<GetUpdatesResp> {
    try {
      return await this.#api.getUpdates(cursor, 5_000);
    } catch {
      throw new WeChatError("WeChat update transport failed");
    }
  }

  public async *download(
    descriptor: WeChatMediaDescriptor,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const reference = mediaReference(descriptor);
    let response: Response;
    try {
      response = await this.fetcher(
        buildCdnDownloadUrl(reference.query, this.credentials.cdnBaseUrl),
        signal === undefined ? {} : { signal },
      );
    } catch {
      throw new WeChatError("WeChat media transport failed");
    }
    if (!response.ok || response.body === null)
      throw new WeChatError("WeChat media download failed");
    const encryptedLimit = descriptor.transportBytes;
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^[0-9]+$/u.test(contentLength) ||
        Number(contentLength) > encryptedLimit)
    ) {
      throw new AppError(
        "media-invalid",
        "WeChat encrypted media exceeds its advertised size",
      );
    }
    if (reference.key === undefined) {
      yield* bodyChunks(response.body, encryptedLimit);
      return;
    }
    const decipher = createDecipheriv("aes-128-ecb", reference.key, null);
    try {
      for await (const chunk of bodyChunks(response.body, encryptedLimit)) {
        const output = decipher.update(chunk);
        if (output.length > 0) yield output;
      }
      const final = decipher.final();
      if (final.length > 0) yield final;
    } catch (error) {
      if (error instanceof AppError || error instanceof WeChatError)
        throw error;
      throw new AppError("media-invalid", "WeChat media decryption failed");
    }
  }

  public async sendText(
    peerId: string,
    value: string,
    contextToken: string,
  ): Promise<void> {
    const characters = Array.from(value);
    try {
      for (
        let offset = 0;
        offset < characters.length;
        offset += WECHAT_TEXT_CHUNK
      ) {
        await this.#sendItem(peerId, contextToken, {
          type: 1,
          text_item: {
            text: characters.slice(offset, offset + WECHAT_TEXT_CHUNK).join(""),
          },
        });
      }
    } catch {
      throw new WeChatError("WeChat text delivery failed");
    }
  }

  public async sendArtifact(
    peerId: string,
    artifact: RuntimeArtifact,
    media: MediaStore,
    contextToken: string,
  ): Promise<void> {
    const filePath = media.verifiedObjectPath(artifact);
    try {
      const uploaded = await this.#upload(
        filePath,
        peerId,
        artifact.mediaKind === "image" ? 1 : 3,
      );
      await this.#sendItem(
        peerId,
        contextToken,
        artifact.mediaKind === "image"
          ? {
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: uploaded.downloadParameter,
                  aes_key: Buffer.from(uploaded.key.toString("hex")).toString(
                    "base64",
                  ),
                  encrypt_type: 1,
                },
                mid_size: uploaded.ciphertextBytes,
              },
            }
          : {
              type: 4,
              file_item: {
                media: {
                  encrypt_query_param: uploaded.downloadParameter,
                  aes_key: Buffer.from(uploaded.key.toString("hex")).toString(
                    "base64",
                  ),
                  encrypt_type: 1,
                },
                file_name: artifact.displayName,
                len: String(uploaded.plaintextBytes),
              },
            },
      );
    } catch {
      throw new WeChatError("WeChat artifact delivery failed");
    }
  }

  async #sendItem(
    peerId: string,
    contextToken: string,
    item: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const waitMilliseconds =
      this.#lastSendAt + WECHAT_SEND_INTERVAL_MS - Date.now();
    if (waitMilliseconds > 0)
      await new Promise<void>((resolve) =>
        setTimeout(resolve, waitMilliseconds),
      );
    this.#lastSendAt = Date.now();
    const body = JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: peerId,
        client_id: `hitch:${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: contextToken,
      },
      base_info: { channel_version: "standalone-0.1.0" },
    });
    let response: Response;
    try {
      const uin = Buffer.from(
        String(randomBytes(4).readUInt32BE(0)),
        "utf8",
      ).toString("base64");
      response = await this.fetcher(
        new URL("ilink/bot/sendmessage", `${this.credentials.baseUrl}/`),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body, "utf8")),
            authorization: `Bearer ${this.credentials.token}`,
            authorizationtype: "ilink_bot_token",
            "x-wechat-uin": uin,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new WeChatError("WeChat send transport failed");
    }
    const contentLength = response.headers.get("content-length");
    if (
      !response.ok ||
      (contentLength !== null &&
        (!/^[0-9]+$/u.test(contentLength) ||
          Number(contentLength) > MAX_API_RESPONSE_BYTES))
    ) {
      throw new WeChatError("WeChat send request failed");
    }
    let decoded: unknown;
    try {
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_API_RESPONSE_BYTES)
        throw new Error("oversized response");
      decoded = JSON.parse(raw);
    } catch {
      throw new WeChatError("WeChat send response is invalid");
    }
    assertApiSuccess(decoded, "WeChat send request");
  }

  async #upload(
    filePath: string,
    peerId: string,
    mediaType: 1 | 3,
  ): Promise<{
    readonly downloadParameter: string;
    readonly key: Buffer;
    readonly plaintextBytes: number;
    readonly ciphertextBytes: number;
  }> {
    const plaintext = await readFile(filePath);
    const key = randomBytes(16);
    const fileKey = randomBytes(16).toString("hex");
    const ciphertextBytes = paddedSize(plaintext.length);
    let uploadResponse: GetUploadUrlResp;
    try {
      uploadResponse = await this.#api.getUploadUrl({
        filekey: fileKey,
        media_type: mediaType,
        to_user_id: peerId,
        rawsize: plaintext.length,
        rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
        filesize: ciphertextBytes,
        no_need_thumb: true,
        aeskey: key.toString("hex"),
      });
    } catch {
      throw new WeChatError("WeChat upload authorization failed");
    }
    assertApiSuccess(uploadResponse, "WeChat upload authorization");
    const rawUploadResponse = uploadResponse as GetUploadUrlResp & {
      readonly upload_full_url?: unknown;
    };
    const uploadUrl =
      rawUploadResponse.upload_full_url !== undefined
        ? parseHttpsUrl(
            rawUploadResponse.upload_full_url,
            "WeChat CDN upload URL",
          )
        : typeof uploadResponse.upload_param === "string" &&
            uploadResponse.upload_param.length > 0
          ? `${this.credentials.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadResponse.upload_param)}&filekey=${encodeURIComponent(fileKey)}`
          : (() => {
              throw new WeChatError(
                "WeChat upload authorization response is incomplete",
              );
            })();
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    if (ciphertext.length !== ciphertextBytes)
      throw new WeChatError("WeChat media encryption size is invalid");
    let response: Response;
    try {
      response = await this.fetcher(uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new WeChatError("WeChat CDN upload transport failed");
    }
    const downloadParameter = response.headers.get("x-encrypted-param");
    if (
      response.status !== 200 ||
      downloadParameter === null ||
      downloadParameter.length === 0 ||
      Buffer.byteLength(downloadParameter, "utf8") > MAX_CDN_QUERY_BYTES ||
      CONTROL_PATTERN.test(downloadParameter)
    ) {
      throw new WeChatError("WeChat CDN upload failed");
    }
    return {
      downloadParameter,
      key,
      plaintextBytes: plaintext.length,
      ciphertextBytes,
    };
  }
}

interface RejectionReply {
  readonly peerId: string;
  readonly contextToken: string;
  readonly result: IngressResult;
}

export class WeChatWorker {
  public constructor(
    readonly accountId: string,
    readonly client: WeChatRawClient,
    readonly state: WeChatStateStore,
    readonly application: HitchApplication,
    readonly store: HitchStore,
    readonly media: MediaStore,
  ) {
    if (state.localAccountId !== accountId) {
      throw new Error("WeChat worker account state does not match");
    }
  }

  async #receive(
    message: unknown,
    signal?: AbortSignal,
  ): Promise<{
    readonly result?: IngressResult;
    readonly context?: readonly [peerId: string, token: string];
  }> {
    let identity;
    try {
      identity = classifyWeChatIdentity(
        this.state.credentials.authenticatedAccountId,
        message,
      );
    } catch (error) {
      if (error instanceof AppError) return {};
      throw error;
    }
    const endpoint = this.store.resolveWeChatEndpoint(
      this.accountId,
      identity.platformUserId,
    );
    if (endpoint === null) return {};
    const contextToken =
      identity.contextToken ?? this.state.context(identity.platformUserId);
    const context =
      identity.contextToken === undefined
        ? undefined
        : ([identity.platformUserId, identity.contextToken] as const);
    if (contextToken === undefined) {
      return {
        result: {
          accepted: false,
          duplicate: false,
          category: "rejected",
          message: "WeChat reply context is missing",
          replyPeerId: identity.platformUserId,
        },
        ...(context === undefined ? {} : { context }),
      };
    }
    const artifacts: RuntimeArtifact[] = [];
    try {
      const descriptors = readWeChatMediaDescriptors(identity);
      for (const descriptor of descriptors) {
        const artifact = await this.media.ingest(
          endpoint.userId,
          this.client.download(descriptor, signal),
          {
            ...(descriptor.plaintextBytes === undefined
              ? {}
              : { advertisedBytes: descriptor.plaintextBytes }),
            advertisedMime: descriptor.advertisedMime,
            displayName: descriptor.displayName,
            expectImage: descriptor.expectImage,
          },
        );
        artifacts.push(artifact);
      }
      const result = this.application.receiveWeChat(
        this.accountId,
        this.state.credentials.authenticatedAccountId,
        message,
        artifacts,
      );
      if (!result.accepted || result.duplicate)
        for (const artifact of artifacts) this.media.discard(artifact);
      return { result, ...(context === undefined ? {} : { context }) };
    } catch (error) {
      for (const artifact of artifacts) this.media.discard(artifact);
      if (error instanceof AppError) {
        return {
          result: {
            accepted: false,
            duplicate: false,
            category: error.category,
            message: error.message,
            replyPeerId: identity.platformUserId,
          },
          ...(context === undefined ? {} : { context }),
        };
      }
      throw error;
    }
  }

  public async pollOnce(signal?: AbortSignal): Promise<number> {
    const cursor = this.state.cursor();
    const response = await this.client.getUpdates(cursor);
    if (response.ret === -14 || response.errcode === -14)
      throw new Error("WeChat login expired; repeat the attended QR login");
    if (
      (response.ret !== undefined && response.ret !== 0) ||
      (response.errcode !== undefined && response.errcode !== 0)
    ) {
      throw new WeChatError("WeChat update request was rejected");
    }
    const messages = response.msgs ?? [];
    if (!Array.isArray(messages) || messages.length > MAX_WECHAT_MESSAGES)
      throw new WeChatError("WeChat update batch is invalid");
    const nextCursor = response.get_updates_buf ?? cursor;
    if (
      typeof nextCursor !== "string" ||
      Buffer.byteLength(nextCursor, "utf8") > 64 * 1024 ||
      CONTROL_PATTERN.test(nextCursor) ||
      (messages.length > 0 &&
        (response.get_updates_buf === undefined || nextCursor.length === 0))
    ) {
      throw new WeChatError("WeChat update cursor is invalid");
    }
    const contexts = new Map<string, string>();
    const rejections: RejectionReply[] = [];
    let handled = 0;
    for (const message of messages) {
      const received = await this.#receive(message, signal);
      if (received.context !== undefined)
        contexts.set(received.context[0], received.context[1]);
      if (
        received.result !== undefined &&
        !received.result.accepted &&
        received.result.replyPeerId !== undefined
      ) {
        const contextToken =
          received.context?.[1] ??
          contexts.get(received.result.replyPeerId) ??
          this.state.context(received.result.replyPeerId);
        if (contextToken !== undefined) {
          rejections.push({
            peerId: received.result.replyPeerId,
            contextToken,
            result: received.result,
          });
        }
      }
      handled += 1;
    }
    if (nextCursor !== cursor || contexts.size > 0)
      this.state.commit(nextCursor, contexts);
    for (const rejection of rejections) {
      await this.client.sendText(
        rejection.peerId,
        `${rejection.result.category ?? "rejected"}: ${rejection.result.message ?? "message rejected"}`,
        rejection.contextToken,
      );
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.deliverOnce();
    return handled;
  }

  async #deliver(delivery: OutboxDelivery): Promise<void> {
    if (!this.store.claimOutbox(delivery)) return;
    try {
      const contextToken = this.state.context(delivery.privateChatId);
      if (contextToken === undefined)
        throw new WeChatError("WeChat delivery context is unavailable");
      if (delivery.kind === "text" && delivery.text !== undefined) {
        await this.client.sendText(
          delivery.privateChatId,
          delivery.text,
          contextToken,
        );
      } else if (
        delivery.kind === "artifact" &&
        delivery.artifact !== undefined
      ) {
        await this.client.sendArtifact(
          delivery.privateChatId,
          delivery.artifact,
          this.media,
          contextToken,
        );
      } else {
        throw new WeChatError("WeChat outbox row is invalid");
      }
      this.store.markOutboxSent(delivery);
    } catch (error) {
      this.store.markOutboxRetryable(delivery);
      throw error;
    }
  }

  public async deliverOnce(): Promise<number> {
    const deliveries = this.store.pendingWeChatOutbox(this.accountId);
    let sent = 0;
    for (const delivery of deliveries) {
      await this.#deliver(delivery);
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
        if (!(error instanceof WeChatError)) throw error;
      }
    }
  }
}
