import { EgressClient } from "../egress/client.js";
import type { EgressServiceConfig } from "../egress/client.js";

export type ComfyBackendErrorCode =
  | "submission-rejected"
  | "submission-unknown"
  | "history-invalid"
  | "history-unavailable"
  | "download-failed"
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

export type ComfyHistory =
  | { readonly state: "pending" }
  | { readonly state: "failed" }
  | { readonly state: "complete"; readonly images: readonly ComfyImageRef[] };

export type ComfyCancelResult = true | false | "unsupported";

const PROMPT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_FILENAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:png|jpe?g|webp)$/iu;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const IMAGE_LIMIT = 8;

/** Host-internal only; job ownership must be bound by the caller. */
export class ComfyBackendClient {
  readonly #control: EgressClient;
  readonly #binary: EgressClient;
  readonly #key: string;

  constructor(operator: EgressServiceConfig) {
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

  async history(
    promptId: string,
    outputNodes: readonly string[],
    signal?: AbortSignal,
  ): Promise<ComfyHistory> {
    if (
      !PROMPT_ID.test(promptId) ||
      !Array.isArray(outputNodes) ||
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
      if (!isRecord(root) || !Object.hasOwn(root, promptId)) throw new Error();
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
      return { state: "complete", images };
    } catch {
      throw new ComfyBackendError("history-invalid");
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
    if (result.status >= 200 && result.status < 300) return true;
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSubfolder(value: string): boolean {
  if (
    value.length === 0 ||
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
