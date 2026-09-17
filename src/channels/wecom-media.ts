import { createDecipheriv, createHash } from "node:crypto";

import { AppError } from "../app/errors.js";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 + 64;
export const WECOM_UPLOAD_CHUNK_BYTES = 512 * 1024;
export const WECOM_IMAGE_LIMIT_BYTES = 10 * 1024 * 1024;
export const WECOM_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
export const WECOM_MIN_UPLOAD_BYTES = 5;
export const WECOM_MAX_UPLOAD_CHUNKS = 100;

export function decryptWeComMedia(encrypted: Buffer, aeskey: string): Buffer {
  const key = Buffer.from(aeskey, "base64");
  if (key.length !== 32)
    throw new AppError("media-invalid", "WeCom media aeskey is invalid");
  if (encrypted.length === 0 || encrypted.length % 32 !== 0)
    throw new AppError("media-invalid", "WeCom media payload is invalid");
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    // The server pads PKCS#7 to a 32-byte multiple, so Node's built-in
    // 16-byte unpadding must stay off and the padding is removed by hand.
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    const padding = decrypted[decrypted.length - 1]!;
    if (padding < 1 || padding > 32 || padding > decrypted.length)
      throw new AppError("media-invalid", "WeCom media padding is invalid");
    for (
      let index = decrypted.length - padding;
      index < decrypted.length;
      index += 1
    )
      if (decrypted[index] !== padding)
        throw new AppError("media-invalid", "WeCom media padding is invalid");
    return decrypted.subarray(0, decrypted.length - padding);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("media-invalid", "WeCom media decryption failed");
  }
}

export function md5Hex(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

export function uploadChunkTotal(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < WECOM_MIN_UPLOAD_BYTES)
    throw new AppError(
      "delivery-failed",
      "WeCom media object is too small to upload",
    );
  const total = Math.ceil(bytes / WECOM_UPLOAD_CHUNK_BYTES);
  if (total > WECOM_MAX_UPLOAD_CHUNKS)
    throw new AppError(
      "delivery-failed",
      "WeCom media object is too large to upload",
    );
  return total;
}

export interface WeComDownload {
  readonly data: Buffer;
  readonly filename?: string;
  readonly mime?: string;
}

// The smart-bot callback carries only url+aeskey; the original filename, when
// present at all, arrives via the download response's Content-Disposition.
export function parseWeComDispositionFilename(
  header: string | null,
): string | undefined {
  if (header === null) return undefined;
  let name: string | undefined;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended !== null) {
    try {
      name = decodeURIComponent(extended[1]!.trim());
    } catch {
      return undefined;
    }
  } else {
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(
      header,
    );
    name = plain?.[1] ?? plain?.[2]?.trim();
  }
  if (name === undefined) return undefined;
  const normalized = name.normalize("NFC");
  if (
    normalized.length === 0 ||
    /[\u0000-\u001f\u007f/\\]/.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > 128
  )
    return undefined;
  return normalized;
}

export async function downloadWeComMedia(url: string): Promise<WeComDownload> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok)
    throw new AppError("media-invalid", "WeCom media download was rejected");
  const advertised = Number(response.headers.get("content-length") ?? 0);
  if (advertised > MAX_DOWNLOAD_BYTES)
    throw new AppError("media-invalid", "WeCom media object is too large");
  if (response.body === null)
    throw new AppError("media-invalid", "WeCom media download is empty");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > MAX_DOWNLOAD_BYTES)
      throw new AppError("media-invalid", "WeCom media object is too large");
    chunks.push(chunk);
  }
  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition");
  const dispositionPreview =
    disposition === null
      ? "absent"
      : disposition.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);
  process.stderr.write(
    `WeCom media download headers: content-type=${contentType ?? "absent"} content-disposition=${dispositionPreview}\n`,
  );
  const filename = parseWeComDispositionFilename(disposition);
  const mime =
    contentType !== null &&
    /^[\x21-\x7e]{1,127}$/.test(contentType) &&
    contentType.includes("/")
      ? contentType
      : undefined;
  return {
    data: Buffer.concat(chunks, bytes),
    ...(filename === undefined ? {} : { filename }),
    ...(mime === undefined ? {} : { mime }),
  };
}
