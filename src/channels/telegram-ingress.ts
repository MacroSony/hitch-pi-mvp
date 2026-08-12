import { createHash } from "node:crypto";

import { AppError } from "../app/errors.js";

const MAX_PROMPT_BYTES = 32 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export interface TelegramIdentity {
  readonly updateId: number;
  readonly messageId: string;
  readonly platformUserId: string;
  readonly privateChatId: string;
  readonly idempotencyKey: string;
  readonly message: Readonly<Record<string, unknown>>;
}

export interface TelegramContent {
  readonly text: string;
  readonly contentDigest: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new AppError("rejected", `Telegram ${label} is missing or unstable`);
  return Number(value);
}

function remoteId(value: unknown, label: string): string {
  if (
    typeof value !== "string" &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  ) {
    throw new AppError("rejected", `Telegram ${label} is missing`);
  }
  const parsed = String(value);
  if (
    parsed.length === 0 ||
    Buffer.byteLength(parsed, "utf8") > 128 ||
    CONTROL_PATTERN.test(parsed)
  ) {
    throw new AppError("rejected", `Telegram ${label} is invalid`);
  }
  return parsed;
}

export function classifyTelegramIdentity(value: unknown): TelegramIdentity {
  const update = record(value);
  if (update === null)
    throw new AppError("rejected", "Telegram update is invalid");
  if (
    Object.keys(update).some((key) => key !== "update_id" && key !== "message")
  ) {
    throw new AppError(
      "rejected",
      "Telegram update has contradictory or unsupported fields",
    );
  }
  const updateId = stableInteger(update.update_id, "update id");
  const message = record(update.message);
  if (message === null || Object.hasOwn(update, "callback_query")) {
    throw new AppError(
      "rejected",
      "only private Telegram text messages are supported",
    );
  }
  const chat = record(message.chat);
  const sender = record(message.from);
  if (chat === null || sender === null || chat.type !== "private") {
    throw new AppError(
      "rejected",
      "Telegram message is not an authenticated private message",
    );
  }
  const privateChatId = remoteId(chat.id, "private chat id");
  const platformUserId = remoteId(sender.id, "sender id");
  const messageId = String(stableInteger(message.message_id, "message id"));
  const idempotencyKey = JSON.stringify([updateId, messageId]);
  return {
    updateId,
    messageId,
    platformUserId,
    privateChatId,
    idempotencyKey,
    message,
  };
}

export function readTelegramContent(
  identity: TelegramIdentity,
): TelegramContent {
  if (
    typeof identity.message.text !== "string" ||
    identity.message.text.length === 0
  ) {
    throw new AppError(
      "rejected",
      "only non-empty Telegram text messages are supported",
    );
  }
  const text = identity.message.text.normalize("NFC");
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES)
    throw new AppError("rejected", "Telegram text is too large");
  const contentDigest = createHash("sha256")
    .update(JSON.stringify({ text }))
    .digest("hex");
  return { text, contentDigest };
}
