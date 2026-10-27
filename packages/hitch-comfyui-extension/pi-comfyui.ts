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
  "paint_get_details",
  "paint_job_cancel",
  "paint_job_status",
  "paint_list_workflows",
  "paint_result",
] as const;
const schemas = {
  paint_get_details: Type.Object(
    {
      workflow: Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}(?![\\s\\S])",
        description:
          "Exact configured short workflow ID from paint_list_workflows; never a filename or path.",
      }),
    },
    { additionalProperties: false },
  ),
  paint_list_workflows: Type.Object({}, { additionalProperties: false }),
  paint_result: Type.Object(
    {
      job_id: Type.String({ minLength: 1, maxLength: 128 }),
      preview: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
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
      duration: Type.Optional(
        Type.Number({
          minimum: 0.5,
          maximum: 15,
          description:
            "Requested video seconds, only for workflows that declare duration; obey their narrower bounds and frame-grid guidance.",
        }),
      ),

      input_files: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Object(
              {
                slot: Type.String({ minLength: 1, maxLength: 64 }),
                input_id: Type.String({ minLength: 1, maxLength: 128 }),
              },
              { additionalProperties: false },
            ),
            Type.Object(
              {
                slot: Type.String({ minLength: 1, maxLength: 64 }),
                job_id: Type.String({ minLength: 1, maxLength: 128 }),
              },
              { additionalProperties: false },
            ),
          ]),
          {
            maxItems: 8,
            description:
              "References for configured file slots: use a current-Turn input_id or your completed image job_id; never a file path.",
          },
        ),
      ),
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
    const maximumResponse =
      tool === "paint_result" ? 1024 * 1024 : MAX_RESPONSE;
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
          if (size > maximumResponse) {
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
              Buffer.byteLength(result) > maximumResponse
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
        name === "paint_result"
          ? "Retrieve your own completed image/video original by job ID. Images can include a bounded native visual preview; video files do NOT provide video vision. The read-only /inbox/results original path can be copied into /workspace with sandbox tools. Completion alone does not mean you reviewed the output."
          : name === "paint"
            ? "Generate an image or short video, or edit an image, with a configured workflow. First choose an ID with paint_list_workflows, then read paint_get_details for its graph NOTE instructions, allowed variables/defaults and reference slots. Input files use current input_id handles or your completed image job_id, never paths. Video/audio reference input is not enabled. Successful output is automatically delivered to this conversation; maximum output is 10MiB."
            : name === "paint_job_status"
              ? "Check your own ComfyUI Paint job status."
              : name === "paint_job_cancel"
                ? "Cancel one of your own ComfyUI Paint jobs."
                : name === "paint_get_details"
                  ? "Inspect an allowlisted workflow before paint: operator graph [NOTE] instructions, description, allowed variables with defaults/limits, file slots and output kind. No graph, backend or fixed-parameter controls. Oversized notes/defaults/enum values are explicitly truncated or omitted."
                  : "List the configured ComfyUI Paint workflows; use paint_get_details for NOTE instructions and defaults.",
      parameters: schemas[name],
      async execute(_id, input, signal) {
        try {
          attest(pi, name);
          const text = await call(socket!, token!, name, input, signal);
          if (name === "paint_result") {
            const value = JSON.parse(text);
            if (
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.kind === "paint-result" &&
              value.preview !== undefined
            ) {
              const preview = value.preview;
              if (
                !preview ||
                typeof preview !== "object" ||
                typeof preview.data !== "string" ||
                !["image/png", "image/jpeg"].includes(preview.mimeType)
              )
                throw new Error("invalid paint preview");
              const decoded = Buffer.from(preview.data, "base64");
              if (
                !decoded.length ||
                decoded.length > 512 * 1024 ||
                decoded.toString("base64") !== preview.data
              )
                throw new Error("invalid paint preview");
              const { preview: _preview, ...metadata } = value;
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      ...metadata,
                      preview_available: true,
                    }),
                  },
                  {
                    type: "image",
                    data: preview.data,
                    mimeType: preview.mimeType,
                  },
                ],
                details: {},
              };
            }
          }
          return { content: [{ type: "text", text }], details: {} };
        } catch {
          throw new Error("paint operation failed");
        }
      },
    });
}
