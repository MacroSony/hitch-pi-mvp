import { createHash } from "node:crypto";

import { AppError } from "../app/errors.js";
import type { RuntimeArtifact } from "../runtime/runtime.js";

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
  readonly textProvided: boolean;
}

export interface TelegramMediaDescriptor {
  readonly fileId: string;
  readonly advertisedBytes?: number;
  readonly advertisedMime?: string;
  readonly displayName: string;
  readonly expectImage: boolean;
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
  artifacts: readonly RuntimeArtifact[] = [],
): TelegramContent {
  const hasText = typeof identity.message.text === "string";
  const hasCaption = typeof identity.message.caption === "string";
  const raw: string | undefined = hasText
    ? (identity.message.text as string)
    : hasCaption
      ? (identity.message.caption as string)
      : artifacts.length > 0
        ? "Please inspect the attached media."
        : undefined;
  if (raw === undefined || raw.length === 0) {
    throw new AppError(
      "rejected",
      "only non-empty Telegram text or media messages are supported",
    );
  }
  if (
    typeof identity.message.text === "string" &&
    (Object.hasOwn(identity.message, "photo") ||
      Object.hasOwn(identity.message, "document"))
  ) {
    throw new AppError("rejected", "Telegram message fields are contradictory");
  }
  const text = raw.normalize("NFC");
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES)
    throw new AppError("rejected", "Telegram text is too large");
  const contentDigest = createHash("sha256")
    .update(
      JSON.stringify(
        artifacts.length === 0
          ? { text }
          : {
              text,
              artifacts: artifacts.map(
                ({ sha256, bytes, mediaKind, mimeType }) => ({
                  sha256,
                  bytes,
                  mediaKind,
                  mimeType,
                }),
              ),
            },
      ),
    )
    .digest("hex");
  return { text, contentDigest, textProvided: hasText || hasCaption };
}

function advertisedBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new AppError("media-invalid", "Telegram media size is invalid");
  return Number(value);
}

export function readTelegramMediaDescriptor(
  identity: TelegramIdentity,
): TelegramMediaDescriptor | null {
  const photo = identity.message.photo;
  const document = record(identity.message.document);
  const video = record(identity.message.video);
  if (
    (photo !== undefined && (document !== null || video !== null)) ||
    (document !== null && video !== null)
  ) {
    throw new AppError("rejected", "Telegram media fields are contradictory");
  }
  if (photo !== undefined) {
    if (!Array.isArray(photo) || photo.length === 0)
      throw new AppError("media-invalid", "Telegram photo metadata is invalid");
    const choices = photo.map((value) => {
      const item = record(value);
      if (item === null)
        throw new AppError(
          "media-invalid",
          "Telegram photo metadata is invalid",
        );
      return {
        fileId: remoteId(item.file_id, "photo file id"),
        bytes: advertisedBytes(item.file_size),
      };
    });
    const selected = choices.reduce((left, right) =>
      (right.bytes ?? 0) >= (left.bytes ?? 0) ? right : left,
    );
    return {
      fileId: selected.fileId,
      ...(selected.bytes === undefined
        ? {}
        : { advertisedBytes: selected.bytes }),
      advertisedMime: "image/jpeg",
      displayName: `telegram-photo-${identity.messageId}.jpg`,
      expectImage: true,
    };
  }
  if (document !== null) {
    const fileName =
      typeof document.file_name === "string"
        ? document.file_name
        : `telegram-file-${identity.messageId}`;
    const size = advertisedBytes(document.file_size);
    return {
      fileId: remoteId(document.file_id, "document file id"),
      ...(size === undefined ? {} : { advertisedBytes: size }),
      ...(typeof document.mime_type === "string"
        ? { advertisedMime: document.mime_type }
        : {}),
      displayName: fileName,
      expectImage: false,
    };
  }
  if (video !== null) {
    const size = advertisedBytes(video.file_size);
    return {
      fileId: remoteId(video.file_id, "video file id"),
      ...(size === undefined ? {} : { advertisedBytes: size }),
      ...(typeof video.mime_type === "string"
        ? { advertisedMime: video.mime_type }
        : { advertisedMime: "video/mp4" }),
      displayName: `telegram-video-${identity.messageId}.mp4`,
      expectImage: false,
    };
  }
  return null;
}
