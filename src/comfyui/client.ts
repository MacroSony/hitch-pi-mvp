import { createHash } from "node:crypto";
import { EgressClient } from "../egress/client.js";
import type { EgressServiceConfig } from "../egress/client.js";

export type ComfyBackendErrorCode =
  | "submission-rejected"
  | "submission-unknown"
  | "history-invalid"
  | "history-unavailable"
  | "download-failed"
  | "upload-failed"
  | "cancel-failed";

/** Stable, sanitized host-internal Comfy operation failure. */
export class ComfyBackendError extends Error {
  readonly code: ComfyBackendErrorCode;

  constructor(code: ComfyBackendErrorCode) {
    super(`Comfy backend ${code}`);
    this.name = "ComfyBackendError";
    this.code = code;
  }
}

export interface ComfyImageRef {
  readonly filename: string;
  readonly subfolder?: string;
  readonly type: "output";
}

export interface ComfyMediaRef {
  readonly filename: string;
  readonly subfolder?: string;
  readonly type: "output";
  readonly kind: "image" | "video";
}

export type ComfyMediaHistory =
  | { readonly state: "pending" }
  | { readonly state: "failed" }
  | { readonly state: "complete"; readonly outputs: readonly ComfyMediaRef[] };

export type ComfyHistory =
  | { readonly state: "pending" }
  | { readonly state: "failed" }
  | { readonly state: "complete"; readonly images: readonly ComfyImageRef[] };

export type ComfyCancelResult = true | false | "unsupported";

const PROMPT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_FILENAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:png|jpe?g|webp)$/iu;
const SAFE_MEDIA_FILENAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:png|jpe?g|webp|mp4)$/iu;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const IMAGE_LIMIT = 8;
const MEDIA_LIMIT = 10;
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_REQUEST_MAX_BYTES = UPLOAD_MAX_BYTES + 64 * 1024;
const MIME_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
};

export function comfyUploadPath(
  scopeKey: string,
  sha256: string,
  mimeType: string,
): string {
  const extension = MIME_EXTENSION[mimeType];
  if (!scopeKey || !/^[a-f0-9]{64}$/u.test(sha256) || !extension)
    throw new ComfyBackendError("upload-failed");
  const digest = createHash("sha256")
    .update(`${scopeKey}:${sha256}`, "utf8")
    .digest("hex");
  return `hitch/${digest}.${extension}`;
}

/** Host-internal only; job ownership must be bound by the caller. */
export class ComfyBackendClient {
  readonly #control: EgressClient;
  readonly #binary: EgressClient;
  readonly #key: string;
  readonly #operator: EgressServiceConfig;
  readonly #operatorHeaders: Readonly<Record<string, string>>;

  constructor(operator: EgressServiceConfig) {
    this.#operator = operator;
    this.#operatorHeaders = operator.headers ?? {};
    this.#key = operator.key;
    this.#control = new EgressClient([operator], {
      maxRequestBytes: 256 * 1024,
      maxResponseBytes: 256 * 1024,
      deadlineMs: 10_000,
      maxRedirects: 0,
    });
    this.#binary = new EgressClient([operator], {
      maxRequestBytes: 256 * 1024,
      maxResponseBytes: 10 * 1024 * 1024,
      deadlineMs: 10_000,
      maxRedirects: 0,
    });
  }

  async submit(
    graph: unknown,
    clientNonce: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let result;
    try {
      result = await this.#control.request({
        serviceKey: this.#key,
        method: "POST",
        path: "/prompt",
        body: JSON.stringify({ prompt: graph, client_id: clientNonce }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw new ComfyBackendError("submission-unknown");
    }
    if (result.status === 400)
      throw new ComfyBackendError("submission-rejected");
    if (result.status !== 200)
      throw new ComfyBackendError("submission-unknown");
    try {
      const data: unknown = JSON.parse(result.text);
      if (
        !isRecord(data) ||
        typeof data.prompt_id !== "string" ||
        !PROMPT_ID.test(data.prompt_id)
      ) {
        throw new Error();
      }
      return data.prompt_id;
    } catch {
      throw new ComfyBackendError("submission-unknown");
    }
  }

  async upload(
    bytes: Uint8Array,
    mimeType: string,
    scopeKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const extension = MIME_EXTENSION[mimeType];
      if (
        !extension ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > UPLOAD_MAX_BYTES ||
        !scopeKey
      )
        throw new Error();
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      const expected = comfyUploadPath(scopeKey, contentHash, mimeType);
      const name = expected.slice("hitch/".length);
      const boundary = "----hitch-comfy-upload-v1";
      const prefix = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
        "ascii",
      );
      const suffix = Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n--${boundary}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\nhitch\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--${boundary}--\r\n`,
        "ascii",
      );
      const body = Buffer.concat([prefix, Buffer.from(bytes), suffix]);
      if (body.byteLength > UPLOAD_REQUEST_MAX_BYTES) throw new Error();
      const headers = {
        ...this.#operatorHeaders,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      };
      const client = new EgressClient([{ ...this.#operator, headers }], {
        maxRequestBytes: UPLOAD_REQUEST_MAX_BYTES,
        maxResponseBytes: 256 * 1024,
        deadlineMs: 10_000,
        maxRedirects: 0,
      });
      const result = await client.request({
        serviceKey: this.#key,
        method: "POST",
        path: "/upload/image",
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.status !== 200) throw new Error();
      const data: unknown = JSON.parse(result.text);
      if (
        !isRecord(data) ||
        data.name !== name ||
        data.subfolder !== "hitch" ||
        data.type !== "input"
      )
        throw new Error();
      return `hitch/${name}`;
    } catch {
      throw new ComfyBackendError("upload-failed");
    }
  }

  async history(
    promptId: string,
    outputNodes: readonly string[],
    signal?: AbortSignal,
  ): Promise<ComfyHistory> {
    if (
      !PROMPT_ID.test(promptId) ||
      !Array.isArray(outputNodes) ||
      outputNodes.length < 1 ||
      outputNodes.length > IMAGE_LIMIT ||
      new Set(outputNodes).size !== outputNodes.length ||
      outputNodes.some(
        (node) => typeof node !== "string" || !SAFE_SEGMENT.test(node),
      )
    ) {
      throw new ComfyBackendError("history-invalid");
    }
    let result;
    try {
      result = await this.#control.request({
        serviceKey: this.#key,
        method: "GET",
        path: `/history/${encodeURIComponent(promptId)}`,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new ComfyBackendError("history-unavailable");
    }
    if (result.status !== 200)
      throw new ComfyBackendError("history-unavailable");

    try {
      const root: unknown = JSON.parse(result.text);
      if (!isRecord(root)) throw new Error();
      if (!Object.hasOwn(root, promptId)) return { state: "pending" };
      const entry = root[promptId];
      if (
        !isRecord(entry) ||
        !isRecord(entry.status) ||
        typeof entry.status.status_str !== "string"
      )
        throw new Error();
      if (entry.status.status_str.toLowerCase() === "error")
        return { state: "failed" };
      if (entry.status.completed !== true) return { state: "pending" };
      if (entry.status.status_str.toLowerCase() !== "success")
        throw new Error();
      if (!isRecord(entry.outputs)) throw new Error();
      const images: ComfyImageRef[] = [];
      for (const node of outputNodes) {
        if (!Object.hasOwn(entry.outputs, node)) continue;
        const output = entry.outputs[node];
        if (!isRecord(output)) throw new Error();
        if (output.images === undefined) continue;
        if (!Array.isArray(output.images)) throw new Error();
        for (const image of output.images) {
          if (
            !isRecord(image) ||
            typeof image.filename !== "string" ||
            !SAFE_FILENAME.test(image.filename) ||
            image.type !== "output"
          )
            throw new Error();
          const subfolder = image.subfolder;
          if (
            subfolder !== undefined &&
            (typeof subfolder !== "string" || !safeSubfolder(subfolder))
          )
            throw new Error();
          images.push(
            subfolder === undefined
              ? { filename: image.filename, type: "output" }
              : { filename: image.filename, subfolder, type: "output" },
          );
          if (images.length > IMAGE_LIMIT) throw new Error();
        }
      }
      if (images.length === 0) throw new Error();
      return { state: "complete", images };
    } catch {
      throw new ComfyBackendError("history-invalid");
    }
  }

  async historyMedia(
    promptId: string,
    outputNodes: readonly string[],
    kind: "image" | "video",
    signal?: AbortSignal,
  ): Promise<ComfyMediaHistory> {
    try {
      if (
        !PROMPT_ID.test(promptId) ||
        !Array.isArray(outputNodes) ||
        outputNodes.length < 1 ||
        outputNodes.length > MEDIA_LIMIT ||
        new Set(outputNodes).size !== outputNodes.length ||
        outputNodes.some(
          (node) => typeof node !== "string" || !SAFE_SEGMENT.test(node),
        )
      )
        throw new Error();
      const response = await this.#control.request({
        serviceKey: this.#key,
        method: "GET",
        path: `/history/${encodeURIComponent(promptId)}`,
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== 200) throw new Error();
      const root: unknown = JSON.parse(response.text);
      if (!isRecord(root)) throw new Error();
      if (!Object.hasOwn(root, promptId)) return { state: "pending" };
      const entry = root[promptId];
      if (
        !isRecord(entry) ||
        !isRecord(entry.status) ||
        typeof entry.status.status_str !== "string"
      )
        throw new Error();
      if (entry.status.status_str.toLowerCase() === "error")
        return { state: "failed" };
      if (entry.status.completed !== true) return { state: "pending" };
      if (
        entry.status.status_str.toLowerCase() !== "success" ||
        !isRecord(entry.outputs)
      )
        throw new Error();
      const outputs: ComfyMediaRef[] = [];
      for (const node of outputNodes) {
        if (!Object.hasOwn(entry.outputs, node)) continue;
        const output = entry.outputs[node];
        if (!isRecord(output)) throw new Error();
        if (kind === "image") {
          if (output.images === undefined) continue;
          if (!Array.isArray(output.images)) throw new Error();
          for (const item of output.images)
            outputs.push(validateMediaRef(item, "image"));
        } else {
          if (output.animated === undefined) continue;
          if (
            !Array.isArray(output.animated) ||
            !output.animated.includes(true) ||
            !Array.isArray(output.images)
          )
            throw new Error();
          for (const item of output.images)
            outputs.push(validateMediaRef(item, "video"));
        }
        if (outputs.length > MEDIA_LIMIT) throw new Error();
      }
      if (outputs.length === 0) throw new Error();
      return { state: "complete", outputs };
    } catch {
      throw new ComfyBackendError("history-invalid");
    }
  }

  /** Raw host-internal bytes only; callers must validate with MediaStore before publishing. */
  async downloadMedia(
    ref: ComfyMediaRef,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    try {
      if (!isSafeMediaRef(ref)) throw new Error();
      const params = new URLSearchParams({
        filename: ref.filename,
        type: "output",
      });
      if (ref.subfolder !== undefined) params.set("subfolder", ref.subfolder);
      const result = await this.#binary.requestBytes({
        serviceKey: this.#key,
        method: "GET",
        path: `/view?${params.toString()}`,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.status !== 200) throw new Error();
      return result.body;
    } catch {
      throw new ComfyBackendError("download-failed");
    }
  }

  /** Raw host-internal bytes only; callers must validate with MediaStore before publishing. */
  async download(ref: ComfyImageRef, signal?: AbortSignal): Promise<Buffer> {
    if (!isSafeImageRef(ref)) throw new ComfyBackendError("download-failed");
    const params = new URLSearchParams({
      filename: ref.filename,
      type: "output",
    });
    if (ref.subfolder !== undefined) params.set("subfolder", ref.subfolder);
    try {
      const result = await this.#binary.requestBytes({
        serviceKey: this.#key,
        method: "GET",
        path: `/view?${params.toString()}`,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.status !== 200) throw new Error();
      return result.body;
    } catch {
      throw new ComfyBackendError("download-failed");
    }
  }

  async cancel(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<ComfyCancelResult> {
    if (!PROMPT_ID.test(promptId)) throw new ComfyBackendError("cancel-failed");
    let result;
    try {
      result = await this.#control.request({
        serviceKey: this.#key,
        method: "POST",
        path: `/api/jobs/${encodeURIComponent(promptId)}/cancel`,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new ComfyBackendError("cancel-failed");
    }
    if (result.status === 404 || result.status === 405) return "unsupported";
    if (result.status !== 200) throw new ComfyBackendError("cancel-failed");
    try {
      const data: unknown = JSON.parse(result.text);
      if (!isRecord(data) || typeof data.cancelled !== "boolean")
        throw new Error();
      return data.cancelled;
    } catch {
      throw new ComfyBackendError("cancel-failed");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSubfolder(value: string): boolean {
  if (value === "") return true;
  if (
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  )
    return false;
  const parts = value.split("/");
  return parts.every(
    (part) =>
      part !== "" && part !== "." && part !== ".." && SAFE_SEGMENT.test(part),
  );
}

function validateMediaRef(
  value: unknown,
  kind: "image" | "video",
): ComfyMediaRef {
  if (
    !isRecord(value) ||
    typeof value.filename !== "string" ||
    !SAFE_MEDIA_FILENAME.test(value.filename) ||
    value.type !== "output"
  )
    throw new Error();
  const extension = value.filename.split(".").pop()?.toLowerCase();
  if ((kind === "video") !== (extension === "mp4")) throw new Error();
  const subfolder = value.subfolder;
  if (
    subfolder !== undefined &&
    (typeof subfolder !== "string" || !safeSubfolder(subfolder))
  )
    throw new Error();
  return subfolder === undefined
    ? { filename: value.filename, type: "output", kind }
    : { filename: value.filename, subfolder, type: "output", kind };
}

function isSafeMediaRef(value: ComfyMediaRef): boolean {
  return (
    isRecord(value) &&
    typeof value.filename === "string" &&
    SAFE_MEDIA_FILENAME.test(value.filename) &&
    value.type === "output" &&
    (value.kind === "image" || value.kind === "video") &&
    (value.kind === "video") ===
      value.filename.toLowerCase().endsWith(".mp4") &&
    (value.subfolder === undefined ||
      (typeof value.subfolder === "string" && safeSubfolder(value.subfolder)))
  );
}

function isSafeImageRef(value: ComfyImageRef): boolean {
  return (
    isRecord(value) &&
    typeof value.filename === "string" &&
    SAFE_FILENAME.test(value.filename) &&
    value.type === "output" &&
    (value.subfolder === undefined ||
      (typeof value.subfolder === "string" && safeSubfolder(value.subfolder)))
  );
}
