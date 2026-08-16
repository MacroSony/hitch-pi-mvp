import { createHash } from "node:crypto";
import { extname } from "node:path";

import { AppError } from "../app/errors.js";
import { MAX_INPUT_ARTIFACT_BYTES } from "../media/media-store.js";
import type { RuntimeArtifact } from "../runtime/runtime.js";

const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_MESSAGE_ITEMS = 16;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export interface WeChatIdentity {
  readonly messageId: string;
  readonly platformUserId: string;
  readonly idempotencyKey: string;
  readonly contextToken?: string;
  readonly message: Readonly<Record<string, unknown>>;
}

export interface WeChatMediaDescriptor {
  readonly item: Readonly<Record<string, unknown>>;
  readonly transportBytes: number;
  readonly plaintextBytes?: number;
  readonly advertisedMime: string;
  readonly displayName: string;
  readonly expectImage: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function remoteId(value: unknown, label: string): string {
  const parsed =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
  if (
    parsed.length === 0 ||
    Buffer.byteLength(parsed, "utf8") > 128 ||
    CONTROL_PATTERN.test(parsed)
  ) {
    throw new AppError("rejected", `WeChat ${label} is invalid`);
  }
  return parsed;
}

function parseMessageId(value: unknown): string {
  const parsed =
    typeof value === "string" && /^[0-9]+$/u.test(value)
      ? value
      : typeof value === "number" && Number.isInteger(value) && value >= 0
        ? String(value)
        : "";
  if (parsed.length === 0 || parsed.length > 64)
    throw new AppError("rejected", "WeChat message id is invalid");
  return parsed;
}

function opaqueToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 64 * 1024 ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new AppError("rejected", "WeChat context token is invalid");
  }
  return value;
}

export function classifyWeChatIdentity(
  authenticatedAccountId: string,
  value: unknown,
): WeChatIdentity {
  const message = record(value);
  if (message === null)
    throw new AppError("rejected", "WeChat message is invalid");
  if (message.message_type !== 1)
    throw new AppError("rejected", "WeChat message is not a user message");
  if (message.group_id !== undefined && message.group_id !== "")
    throw new AppError("rejected", "WeChat group messages are not supported");
  const platformUserId = remoteId(message.from_user_id, "sender id");
  if (
    message.to_user_id !== undefined &&
    remoteId(message.to_user_id, "recipient id") !== authenticatedAccountId
  ) {
    throw new AppError("rejected", "WeChat recipient does not match the bot");
  }
  const messageId = parseMessageId(message.message_id);
  const contextToken =
    message.context_token === undefined
      ? undefined
      : opaqueToken(message.context_token);
  return {
    messageId,
    platformUserId,
    idempotencyKey: JSON.stringify([
      authenticatedAccountId,
      platformUserId,
      messageId,
    ]),
    ...(contextToken === undefined ? {} : { contextToken }),
    message,
  };
}

function integerBytes(value: unknown, label: string): number {
  const parsed =
    typeof value === "string" && /^[0-9]+$/u.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1)
    throw new AppError("media-invalid", `WeChat ${label} is invalid`);
  return Number(parsed);
}

function plaintextBytes(value: unknown, label: string): number {
  const bytes = integerBytes(value, label);
  if (bytes > MAX_INPUT_ARTIFACT_BYTES)
    throw new AppError("media-invalid", `WeChat ${label} exceeds MVP limits`);
  return bytes;
}

function encryptedBytes(value: unknown, label: string): number {
  const bytes = integerBytes(value, label);
  const maximum = Math.ceil((MAX_INPUT_ARTIFACT_BYTES + 1) / 16) * 16;
  if (bytes > maximum || bytes % 16 !== 0)
    throw new AppError("media-invalid", `WeChat ${label} exceeds MVP limits`);
  return bytes;
}

function mimeFromName(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".zip":
      return "application/zip";
    case ".mp3":
      return "audio/mpeg";
    case ".mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

function messageItems(
  identity: WeChatIdentity,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(identity.message.item_list))
    throw new AppError("rejected", "WeChat message items are missing");
  if (identity.message.item_list.length > MAX_MESSAGE_ITEMS)
    throw new AppError("rejected", "WeChat message item count exceeds limits");
  return identity.message.item_list.map((value) => {
    const item = record(value);
    if (item === null)
      throw new AppError("rejected", "WeChat message item is invalid");
    return item;
  });
}

export function readWeChatMediaDescriptors(
  identity: WeChatIdentity,
): readonly WeChatMediaDescriptor[] {
  const descriptors: WeChatMediaDescriptor[] = [];
  for (const item of messageItems(identity)) {
    switch (item.type) {
      case 1:
        break;
      case 2: {
        const image = record(item.image_item);
        if (image === null)
          throw new AppError(
            "media-invalid",
            "WeChat image metadata is invalid",
          );
        plaintextBytes(image.hd_size ?? image.mid_size, "image size");
        descriptors.push({
          item,
          transportBytes: Math.ceil((MAX_INPUT_ARTIFACT_BYTES + 1) / 16) * 16,
          advertisedMime: "image/jpeg",
          displayName: `wechat-image-${identity.messageId}.jpg`,
          expectImage: true,
        });
        break;
      }
      case 3:
        throw new AppError(
          "media-invalid",
          "WeChat voice media has no trustworthy advertised byte size",
        );
      case 4: {
        const file = record(item.file_item);
        if (file === null)
          throw new AppError(
            "media-invalid",
            "WeChat file metadata is invalid",
          );
        const displayName =
          typeof file.file_name === "string"
            ? file.file_name
            : `wechat-file-${identity.messageId}.bin`;
        const bytes = plaintextBytes(file.len, "file size");
        descriptors.push({
          item,
          transportBytes: Math.ceil((bytes + 1) / 16) * 16,
          plaintextBytes: bytes,
          advertisedMime: mimeFromName(displayName),
          displayName,
          expectImage: false,
        });
        break;
      }
      case 5: {
        const video = record(item.video_item);
        if (video === null)
          throw new AppError(
            "media-invalid",
            "WeChat video metadata is invalid",
          );
        descriptors.push({
          item,
          transportBytes: encryptedBytes(video.video_size, "video size"),
          advertisedMime: "video/mp4",
          displayName: `wechat-video-${identity.messageId}.mp4`,
          expectImage: false,
        });
        break;
      }
      default:
        throw new AppError(
          "rejected",
          "WeChat message item type is unsupported",
        );
    }
  }
  if (descriptors.length > 8)
    throw new AppError(
      "media-invalid",
      "WeChat media count exceeds MVP limits",
    );
  return descriptors;
}

export function readWeChatContent(
  identity: WeChatIdentity,
  artifacts: readonly RuntimeArtifact[] = [],
): { text: string; contentDigest: string; textProvided: boolean } {
  const texts: string[] = [];
  let textBytes = 0;
  for (const item of messageItems(identity)) {
    if (item?.type !== 1) continue;
    const textItem = record(item.text_item);
    if (typeof textItem?.text !== "string" || textItem.text.length === 0)
      throw new AppError("rejected", "WeChat text item is invalid");
    textBytes += Buffer.byteLength(textItem.text, "utf8");
    if (textBytes > MAX_PROMPT_BYTES)
      throw new AppError("rejected", "WeChat text is too large");
    texts.push(textItem.text);
  }
  const text = (
    texts.length === 0 && artifacts.length > 0
      ? "Please inspect the attached media."
      : texts.join("\n")
  ).normalize("NFC");
  if (text.length === 0)
    throw new AppError("rejected", "WeChat message has no supported content");
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES)
    throw new AppError("rejected", "WeChat text is too large");
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
  return { text, contentDigest, textProvided: texts.length > 0 };
}
