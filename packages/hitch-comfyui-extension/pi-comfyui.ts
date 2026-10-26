import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attestToolSet } from "./manifest-attest.mjs";

const socket = process.env.HITCH_COMFY_SOCKET;
const token = process.env.HITCH_COMFY_TOKEN;
const extensionPath = process.env.HITCH_COMFY_EXTENSION_PATH;
if (
  (socket === undefined) !== (token === undefined) ||
  (socket === undefined) !== (extensionPath === undefined)
)
  throw new Error("Comfy bridge configuration incomplete");
if (
  socket !== undefined &&
  (!socket.startsWith("/") ||
    token === undefined ||
    !/^[a-f0-9]{64}$/.test(token) ||
    extensionPath !== fileURLToPath(import.meta.url))
)
  throw new Error("Comfy bridge configuration invalid");
const names = [
  "paint",
  "paint_job_cancel",
  "paint_job_status",
  "paint_list_workflows",
] as const;
const schemas = {
  paint_list_workflows: Type.Object({}, { additionalProperties: false }),
  paint: Type.Object(
    {
      workflow: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description: "Optional configured short workflow name.",
        }),
      ),
      prompt: Type.String({ minLength: 1, maxLength: 8192 }),
      negative_prompt: Type.Optional(Type.String({ maxLength: 8192 })),
      width: Type.Optional(Type.Integer({ minimum: 256, maximum: 1536 })),
      height: Type.Optional(Type.Integer({ minimum: 256, maximum: 1536 })),
    },
    { additionalProperties: false },
  ),
  paint_job_status: Type.Object(
    {
      job_id: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description: "Omit to list only your own recent jobs.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  paint_job_cancel: Type.Object(
    {
      job_id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: "Job identifier returned by your own paint request.",
      }),
    },
    { additionalProperties: false },
  ),
} as const;
const MAX_RESPONSE = 32 * 1024;
function attest(pi: ExtensionAPI, tool: (typeof names)[number]): void {
  if (!socket || !token) throw new Error("paint bridge is unavailable");
  const activeRaw = process.env.HITCH_ACTIVE_TOOLS;
  if (activeRaw === undefined) throw new Error("active tool policy missing");
  let active: unknown;
  try {
    active = JSON.parse(activeRaw);
  } catch {
    throw new Error("active tool policy invalid");
  }
  if (!Array.isArray(active) || !active.includes(tool))
    throw new Error("paint tool is not active");
  const sourcePath = process.env.HITCH_P0_EXTENSION_PATH;
  if (!sourcePath) throw new Error("mandatory extension path missing");
  attestToolSet(pi, {
    label: "sandbox",
    defaultPath: sourcePath,
    pathOverrides: {
      ...(process.env.HITCH_WEB_SEARCH_ENABLED === "1"
        ? { web_search: process.env.HITCH_WEB_SEARCH_EXTENSION_PATH! }
        : {}),
      ...Object.fromEntries(names.map((name) => [name, extensionPath!])),
    },
  });
}
function call(
  socketPath: string,
  bearer: string,
  tool: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const req = httpRequest(
      {
        socketPath,
        method: "POST",
        path: "/execute",
        headers: {
          "x-hitch-token": bearer,
          "content-type": "application/json",
        },
        timeout: 15_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_RESPONSE) {
            req.destroy();
            finish(new Error("paint response too large"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          try {
            const body = Buffer.concat(chunks, size).toString("utf8");
            if (response.statusCode !== 200) throw new Error("failed");
            const parsed = JSON.parse(body) as { result?: unknown };
            const result = JSON.stringify(parsed.result);
            if (
              result === undefined ||
              Buffer.byteLength(result) > MAX_RESPONSE
            )
              throw new Error("failed");
            finish(undefined, result);
          } catch {
            finish(new Error("paint operation failed"));
          }
        });
        response.on("error", () => finish(new Error("paint operation failed")));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(new Error("paint request timed out"));
    }, 15_000);
    const onAbort = () => {
      req.destroy();
      finish(new Error("paint request aborted"));
    };
    req.on("error", () => finish(new Error("paint operation failed")));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    req.end(JSON.stringify({ tool, input }));
  });
}
export default function (pi: ExtensionAPI): void {
  for (const name of names)
    pi.registerTool({
      name,
      label: name,
      description:
        name === "paint"
          ? "Create an image; successful output is automatically delivered to this conversation."
          : name === "paint_job_status"
            ? "Check your own ComfyUI Paint job status."
            : name === "paint_job_cancel"
              ? "Cancel one of your own ComfyUI Paint jobs."
              : "List the configured ComfyUI Paint workflows.",
      parameters: schemas[name],
      async execute(_id, input, signal) {
        try {
          attest(pi, name);
          const text = await call(socket!, token!, name, input, signal);
          return { content: [{ type: "text", text }], details: {} };
        } catch {
          throw new Error("paint operation failed");
        }
      },
    });
}
