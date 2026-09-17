import { createHash } from "node:crypto";

import { AppError } from "../app/errors.js";

const MAX_PROMPT_BYTES = 32 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const PRIVATE_TEXT_MESSAGE =
  "only Enterprise WeChat private text messages are supported";
const MEDIA_MESSAGE = "Enterprise WeChat media is not supported yet";

export interface WeComIdentity {
  readonly msgid: string;
  readonly platformUserId: string;
  readonly msgtype: string;
  readonly idempotencyKey: string;
}

export interface WeComContent {
  readonly text: string;
  readonly contentDigest: string;
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
  return {
    msgid,
    platformUserId,
    msgtype: body.msgtype,
    idempotencyKey: msgid,
  };
}

export function readWeComContent(
  identity: WeComIdentity,
  value: unknown,
): WeComContent {
  const body = record(record(value)?.body);
  switch (identity.msgtype) {
    case "text":
      break;
    case "image":
    case "file":
    case "video":
    case "voice":
    case "mixed":
    case "template_card":
      throw new AppError("rejected", MEDIA_MESSAGE);
    default:
      throw new AppError(
        "rejected",
        "Enterprise WeChat message type is unsupported",
      );
  }
  const text = record(body?.text)?.content;
  if (typeof text !== "string")
    throw new AppError("rejected", "WeCom text is invalid");
  const normalized = text.normalize("NFC");
  if (normalized.length === 0)
    throw new AppError("rejected", PRIVATE_TEXT_MESSAGE);
  if (Buffer.byteLength(normalized, "utf8") > MAX_PROMPT_BYTES)
    throw new AppError("rejected", "WeCom text is too large");
  return {
    text: normalized,
    contentDigest: createHash("sha256").update(normalized).digest("hex"),
  };
}
