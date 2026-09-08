import fs from "node:fs";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
// Block transport too: a replaced fetch must never turn dummy credentials into
// a real provider request. Pi's dispatcher captures fetch at public import time;
// override it AFTER that import so the CLI preserves this deliberate fixture.
dns.lookup = (_host, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  queueMicrotask(() => cb(new Error("antigravity-fixture-network-denied")));
};
http.request = https.request = () => {
  throw new Error("antigravity-fixture-network-denied");
};
syncBuiltinESMExports();
await import("@earendil-works/pi-coding-agent");

const EXPIRED_ACCESS = "HITCH_ANTIGRAVITY_ACCESS_EXPIRED";
const REFRESH_TOKEN = "HITCH_ANTIGRAVITY_REFRESH";
const REFRESHED_ACCESS = "HITCH_ANTIGRAVITY_ACCESS_REFRESHED";
const VALID_ACCESS = "HITCH_ANTIGRAVITY_ACCESS_VALID";
const ROTATED_REFRESH = "HITCH_ANTIGRAVITY_REFRESH_ROTATED";
const mode = process.env.HITCH_ANTIGRAVITY_FIXTURE_MODE ?? "stream";
function logPath() {
  return (
    process.env.HITCH_B2_PROVIDER_LOG ??
    (process.env.HITCH_P0_LOG
      ? `${process.env.HITCH_P0_LOG.slice(0, process.env.HITCH_P0_LOG.lastIndexOf("/"))}/provider.log`
      : undefined)
  );
}

function log(metadata) {
  const path = logPath();
  if (path)
    fs.appendFileSync(path, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
}

function requestUrl(input) {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  if (input instanceof Request) return new URL(input.url);
  throw new Error("antigravity-network-denied");
}

function bearer(init, input) {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const value = headers.get("authorization") ?? "";
  return (
    value === `Bearer ${REFRESHED_ACCESS}` || value === `Bearer ${VALID_ACCESS}`
  );
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(value) {
  const body = `data: ${JSON.stringify({ response: value })}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = requestUrl(input);

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    const body = String(
      init.body ?? (input instanceof Request ? await input.clone().text() : ""),
    );
    const params = new URLSearchParams(body);
    const valid = params.get("refresh_token") === REFRESH_TOKEN;
    log({ kind: "token", tokenValid: valid });
    if (!valid) return jsonResponse({ error: "invalid_grant" }, 400);
    return jsonResponse({
      access_token: REFRESHED_ACCESS,
      refresh_token: ROTATED_REFRESH,
      expires_in: 3600,
    });
  }

  const cloudHost =
    url.hostname === "cloudcode-pa.googleapis.com" ||
    url.hostname === "daily-cloudcode-pa.sandbox.googleapis.com";
  if (cloudHost && url.pathname === "/v1internal:fetchAvailableModels") {
    const valid = bearer(init, input);
    log({
      kind: "models",
      tokenValid: valid,
      model: "gemini-3.7-flash-tiered",
      toolSeen: false,
    });
    if (!valid)
      return jsonResponse({ error: { message: "unauthorized" } }, 401);
    return jsonResponse({
      models: {
        "gemini-3.7-flash-tiered": {
          displayName: "Gemini 3.7 Flash (Tiered)",
          modelName: "gemini-3.7-flash-tiered",
          supportsThinking: true,
        },
      },
    });
  }

  if (cloudHost && url.pathname === "/v1internal:streamGenerateContent") {
    const valid = bearer(init, input);
    let body;
    try {
      body = JSON.parse(
        String(
          init.body ??
            (input instanceof Request ? await input.clone().text() : ""),
        ),
      );
    } catch {
      body = {};
    }
    const request =
      body && typeof body.request === "object" ? body.request : {};
    const contents = Array.isArray(request.contents) ? request.contents : [];
    const toolSeen = contents.some(
      (content) =>
        Array.isArray(content?.parts) &&
        content.parts.some((part) => part?.functionResponse !== undefined),
    );
    const requestedModel = typeof body.model === "string" ? body.model : "";
    log({ kind: "stream", tokenValid: valid, model: requestedModel, toolSeen });
    if (!valid || requestedModel !== "gemini-3.8-flash-tiered") {
      return jsonResponse(
        { error: { message: "invalid fixture request" } },
        400,
      );
    }
    if (mode === "404") {
      return jsonResponse(
        { error: { message: "Requested entity was not found" } },
        404,
      );
    }
    if (!toolSeen) {
      return sseResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "read",
                    id: "fixture-read",
                    args: { path: "HITCH_ANTIGRAVITY_READ_SENTINEL" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      });
    }
    return sseResponse({
      candidates: [
        {
          content: {
            parts: [{ text: "HITCH_ANTIGRAVITY_STREAM_TOOL_LOOP_SETTLED" }],
          },
          finishReason: "STOP",
        },
      ],
    });
  }

  // Never delegate: this fixture must make every unexpected network attempt fail.
  throw new Error("antigravity-network-denied");
};
