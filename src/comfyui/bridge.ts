import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, chmod, lstat, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ComfyToolContext,
  ComfyToolHost,
  ComfyToolName,
} from "./types.js";

export const COMFY_BRIDGE_MAX_BODY_BYTES = 128 * 1024;
export const COMFY_BRIDGE_MAX_RESULT_BYTES = 32 * 1024;
export const COMFY_BRIDGE_MAX_MEDIA_RESULT_BYTES = 1024 * 1024;
export const COMFY_BRIDGE_TIMEOUT_MS = 15_000;
const MAX_HEADER_BYTES = 4 * 1024;
const TOOL_NAMES: readonly ComfyToolName[] = [
  "paint_list_workflows",
  "paint",
  "paint_job_status",
  "paint_get_details",
  "paint_job_cancel",
  "paint_result",
];
const short = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

export function validComfyRequest(
  value: unknown,
): value is { tool: ComfyToolName; input: Record<string, unknown> } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).sort().join(",") !== "input,tool" ||
    !TOOL_NAMES.includes(request.tool as ComfyToolName)
  )
    return false;
  const input = request.input;
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return false;
  const fields = input as Record<string, unknown>,
    keys = Object.keys(fields);
  const only = (...allowed: string[]) =>
    keys.every((key) => allowed.includes(key));
  switch (request.tool) {
    case "paint_get_details":
      return (
        only("workflow") &&
        typeof fields.workflow === "string" &&
        /^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\s\S])/.test(fields.workflow)
      );
    case "paint_list_workflows":
      return only();
    case "paint":
      return (
        only(
          "workflow",
          "prompt",
          "negative_prompt",
          "width",
          "height",
          "input_files",
          "duration",
        ) &&
        (fields.duration === undefined ||
          (typeof fields.duration === "number" &&
            Number.isFinite(fields.duration) &&
            fields.duration >= 0.5 &&
            fields.duration <= 15)) &&
        (fields.input_files === undefined ||
          (Array.isArray(fields.input_files) &&
            fields.input_files.length <= 8 &&
            fields.input_files.every((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value))
                return false;
              const ref = value as Record<string, unknown>;
              const keys = Object.keys(ref).sort().join(",");
              return (
                short(ref.slot) &&
                ((keys === "input_id,slot" && short(ref.input_id)) ||
                  (keys === "job_id,slot" && short(ref.job_id)))
              );
            }))) &&
        typeof fields.prompt === "string" &&
        fields.prompt.length >= 1 &&
        fields.prompt.length <= 8192 &&
        (fields.workflow === undefined || short(fields.workflow)) &&
        (fields.negative_prompt === undefined ||
          (typeof fields.negative_prompt === "string" &&
            fields.negative_prompt.length <= 8192)) &&
        [fields.width, fields.height].every(
          (v) =>
            v === undefined ||
            (Number.isInteger(v) && Number(v) >= 256 && Number(v) <= 1536),
        )
      );
    case "paint_job_status":
      return (
        only("job_id") && (fields.job_id === undefined || short(fields.job_id))
      );
    case "paint_job_cancel":
      return only("job_id") && short(fields.job_id);
    case "paint_result":
      return (
        only("job_id", "preview") &&
        short(fields.job_id) &&
        (fields.preview === undefined || typeof fields.preview === "boolean")
      );
  }
  return false;
}
function jsonBytes(
  value: unknown,
  limit = COMFY_BRIDGE_MAX_RESULT_BYTES,
): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("invalid result");
  const bytes = Buffer.from(text);
  if (bytes.length > limit) throw new Error("result too large");
  return bytes;
}
function reply(
  response: ServerResponse,
  status: number,
  value: unknown,
  limit = COMFY_BRIDGE_MAX_RESULT_BYTES,
): void {
  if (response.destroyed || response.writableEnded) return;
  let body: Buffer;
  try {
    body = jsonBytes(value, limit);
  } catch {
    status = 502;
    body = Buffer.from('{"error":"comfy operation failed"}');
  }
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    connection: "close",
  });
  response.end(body);
}
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > COMFY_BRIDGE_MAX_BODY_BYTES) throw new Error("oversize");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}
export class ComfyToolBridge {
  readonly socketPath: string;
  readonly token: string;
  readonly #server: Server;
  readonly #connections = new Set<import("node:net").Socket>();
  readonly #controllers = new Set<AbortController>();
  #closed = false;
  private constructor(
    readonly root: string,
    socketPath: string,
    token: string,
    server: Server,
  ) {
    this.socketPath = socketPath;
    this.token = token;
    this.#server = server;
  }

  static async start(
    root: string,
    context: ComfyToolContext,
    host: ComfyToolHost,
  ): Promise<ComfyToolBridge> {
    // The caller supplies a fresh private child path. Never adopt or remove an existing path.
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o700);
    const socketPath = join(root, "comfy.sock"),
      token = randomBytes(32).toString("hex");
    const captured = Object.freeze({
      userId: context.userId,
      turnId: context.turnId,
      ...(context.inputs === undefined
        ? {}
        : {
            inputs: Object.freeze(
              context.inputs.map((entry) =>
                Object.freeze({
                  id: entry.id,
                  artifact: Object.freeze({ ...entry.artifact }),
                }),
              ),
            ),
          }),
      ...(context.attachResult === undefined
        ? {}
        : { attachResult: context.attachResult }),
    });
    let bridge: ComfyToolBridge | undefined;
    const server = createServer(
      {
        maxHeaderSize: MAX_HEADER_BYTES,
        requestTimeout: COMFY_BRIDGE_TIMEOUT_MS,
        headersTimeout: COMFY_BRIDGE_TIMEOUT_MS,
      },
      (request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/execute") {
            reply(response, 404, { error: "invalid request" });
            return;
          }
          const authorization = request.headers["x-hitch-token"];
          const supplied = Buffer.from(
            typeof authorization === "string" ? authorization : "",
          );
          const expected = Buffer.from(token);
          if (
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)
          ) {
            reply(response, 401, { error: "invalid request" });
            return;
          }
          const length = request.headers["content-length"];
          if (
            length !== undefined &&
            (!/^\d+$/.test(length) ||
              Number(length) > COMFY_BRIDGE_MAX_BODY_BYTES)
          ) {
            request.resume();
            reply(response, 413, { error: "invalid request" });
            return;
          }
          let body: Buffer;
          try {
            body = await readBody(request);
          } catch {
            reply(response, 413, { error: "invalid request" });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString("utf8"));
          } catch {
            reply(response, 400, { error: "invalid request" });
            return;
          }
          if (!validComfyRequest(parsed)) {
            reply(response, 400, { error: "invalid request" });
            return;
          }
          const resultLimit =
            parsed.tool === "paint_result"
              ? COMFY_BRIDGE_MAX_MEDIA_RESULT_BYTES
              : COMFY_BRIDGE_MAX_RESULT_BYTES;
          const live = bridge;
          if (!live) {
            reply(response, 503, { error: "bridge unavailable" });
            return;
          }
          const controller = new AbortController();
          live.#controllers.add(controller);
          let finished = false;
          const complete = (status: number, value: unknown) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            live.#controllers.delete(controller);
            reply(response, status, value, resultLimit);
          };
          const timer = setTimeout(() => {
            controller.abort();
            complete(504, { error: "comfy operation timed out" });
          }, COMFY_BRIDGE_TIMEOUT_MS);
          request.on("aborted", () => {
            controller.abort();
            complete(499, { error: "request aborted" });
          });
          response.on("close", () => {
            if (!response.writableEnded) {
              controller.abort();
              clearTimeout(timer);
              live.#controllers.delete(controller);
              finished = true;
            }
          });
          // Promise handlers consume both outcomes even if timeout/client-close won the race.
          void Promise.resolve()
            .then(() =>
              host.execute(
                captured,
                parsed.tool,
                parsed.input,
                controller.signal,
              ),
            )
            .then(
              (value) => {
                try {
                  const safe = JSON.parse(
                    jsonBytes(value, resultLimit).toString("utf8"),
                  ) as unknown;
                  complete(200, { result: safe });
                } catch {
                  complete(502, { error: "comfy operation failed" });
                }
              },
              () => complete(502, { error: "comfy operation failed" }),
            );
        })().catch(() => reply(response, 400, { error: "invalid request" }));
      },
    );
    server.on("connection", (connection) => {
      const live = bridge;
      if (live) {
        live.#connections.add(connection);
        connection.on("close", () => live.#connections.delete(connection));
      }
    });
    bridge = new ComfyToolBridge(root, socketPath, token, server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      const stat = await lstat(socketPath);
      if (!stat.isSocket() || (stat.mode & 0o077) !== 0)
        throw new Error("unsafe comfy socket");
      return bridge;
    } catch (error) {
      server.close();
      await unlink(socketPath).catch(() => undefined);
      await rmdir(root).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    for (const connection of this.#connections) connection.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await unlink(this.socketPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    // Remove only this bridge's empty child directory; never recursively delete caller-owned content.
    await rmdir(this.root);
  }
}
