import { createHash } from "node:crypto";

import { AppError } from "../app/errors.js";

const MAX_PROMPT_BYTES = 32 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const PRIVATE_TEXT_MESSAGE =
  "only Enterprise WeChat private text messages are supported";
const MEDIA_MESSAGE = "Enterprise WeChat mixed messages are not supported yet";

export interface WeComMediaDescriptor {
  readonly kind: "image" | "file" | "video";
  readonly url: string;
  readonly aeskey: string;
}

export interface WeComIdentity {
  readonly msgid: string;
  readonly platformUserId: string;
  readonly msgtype: string;
  readonly idempotencyKey: string;
  readonly media?: WeComMediaDescriptor;
}

export interface WeComContent {
  readonly text: string;
  readonly contentDigest: string;
  readonly textProvided: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 128 ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new AppError("rejected", `WeCom ${label} is invalid`);
  }
  return value;
}

function mediaDescriptor(
  kind: "image" | "file" | "video",
  value: unknown,
): WeComMediaDescriptor {
  const descriptor = record(value);
  const url = descriptor?.url;
  const aeskey = descriptor?.aeskey;
  if (
    typeof url !== "string" ||
    !url.startsWith("https://") ||
    Buffer.byteLength(url, "utf8") > 2048 ||
    CONTROL_PATTERN.test(url)
  )
    throw new AppError(
      "media-invalid",
      `WeCom ${kind} download url is invalid`,
    );
  if (
    typeof aeskey !== "string" ||
    Buffer.from(aeskey, "base64").length !== 32 ||
    Buffer.byteLength(aeskey, "utf8") > 128
  )
    throw new AppError("media-invalid", `WeCom ${kind} aeskey is invalid`);
  return { kind, url, aeskey };
}

export function classifyWeComIdentity(
  expectedBotId: string,
  value: unknown,
): WeComIdentity {
  const callback = record(value);
  if (callback === null || callback.cmd !== "aibot_msg_callback")
    throw new AppError("rejected", "WeCom callback is invalid");
  const headers = record(callback.headers);
  if (headers === null)
    throw new AppError("rejected", "WeCom callback headers are invalid");
  if (
    headers.req_id !== undefined &&
    (typeof headers.req_id !== "string" ||
      Buffer.byteLength(headers.req_id, "utf8") > 128)
  ) {
    throw new AppError("rejected", "WeCom callback request id is invalid");
  }
  const body = record(callback.body);
  if (body === null)
    throw new AppError("rejected", "WeCom callback body is invalid");
  const msgid = boundedIdentifier(body.msgid, "message id");
  if (body.aibotid !== expectedBotId)
    throw new AppError("rejected", "WeCom callback bot does not match");
  if (body.chattype !== "single")
    throw new AppError("rejected", PRIVATE_TEXT_MESSAGE);
  if (typeof body.msgtype !== "string" || body.msgtype.length === 0)
    throw new AppError("rejected", "WeCom message type is invalid");
  const from = record(body.from);
  const platformUserId = boundedIdentifier(from?.userid, "sender id");
  const base = {
    msgid,
    platformUserId,
    msgtype: body.msgtype,
    idempotencyKey: msgid,
  };
  switch (body.msgtype) {
    case "text":
    case "voice":
      return base;
    case "image":
      return { ...base, media: mediaDescriptor("image", body.image) };
    case "file":
      return { ...base, media: mediaDescriptor("file", body.file) };
    case "video":
      return { ...base, media: mediaDescriptor("video", body.video) };
    case "mixed":
    case "template_card":
      return base;
    default:
      throw new AppError(
        "rejected",
        "Enterprise WeChat message type is unsupported",
      );
  }
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new AppError("rejected", `WeCom ${label} is invalid`);
  const normalized = value.normalize("NFC");
  if (normalized.length === 0)
    throw new AppError("rejected", `WeCom ${label} is empty`);
  if (Buffer.byteLength(normalized, "utf8") > MAX_PROMPT_BYTES)
    throw new AppError("rejected", `WeCom ${label} is too large`);
  return normalized;
}

export function readWeComContent(
  identity: WeComIdentity,
  value: unknown,
): WeComContent {
  if (identity.msgtype === "mixed" || identity.msgtype === "template_card")
    throw new AppError("rejected", MEDIA_MESSAGE);
  const body = record(record(value)?.body);
  if (identity.media !== undefined) {
    return {
      text: "",
      contentDigest: createHash("sha256")
        .update(`wecom-media:${identity.media.kind}:${identity.media.url}`)
        .digest("hex"),
      textProvided: false,
    };
  }
  if (identity.msgtype === "voice") {
    const text = boundedText(record(body?.voice)?.content, "voice");
    return {
      text,
      contentDigest: createHash("sha256").update(text).digest("hex"),
      textProvided: true,
    };
  }
  const text = boundedText(record(body?.text)?.content, "text");
  return {
    text,
    contentDigest: createHash("sha256").update(text).digest("hex"),
    textProvided: true,
  };
}
