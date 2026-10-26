import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, lstat, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  ComfyToolBridge,
  COMFY_BRIDGE_MAX_BODY_BYTES,
} from "../src/comfyui/bridge.js";
import type {
  ComfyToolContext,
  ComfyToolHost,
  ComfyToolName,
} from "../src/comfyui/types.js";

const owner = Object.freeze({ userId: "user-a", turnId: "turn-42" });
function call(
  bridge: ComfyToolBridge,
  body: unknown,
  options: {
    token?: string;
    method?: string;
    path?: string;
    headers?: IncomingHttpHeaders;
    fragment?: boolean;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(
      typeof body === "string" ? body : JSON.stringify(body),
    );
    const req = httpRequest(
      {
        socketPath: bridge.socketPath,
        method: options.method ?? "POST",
        path: options.path ?? "/execute",
        headers: {
          "x-hitch-token": options.token ?? bridge.token,
          "content-length": data.length,
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.fragment) {
      req.write(data.subarray(0, Math.min(3, data.length)));
      setTimeout(() => req.end(data.subarray(Math.min(3, data.length))), 5);
    } else req.end(data);
  });
}
async function setup(execute: ComfyToolHost["execute"]) {
  const parent = await mkdtemp(join(tmpdir(), "comfy-bridge-test-"));
  const root = join(parent, "bridge-unique");
  const host: ComfyToolHost = { enabledUsers: [owner.userId], execute };
  const bridge = await ComfyToolBridge.start(root, owner, host);
  return { parent, root, bridge };
}
const listRequest = { tool: "paint_list_workflows", input: {} };

test("Unix HTTP bridge tolerates fragmented body and delegates only captured frozen owner/turn", async () => {
  let observed:
    | {
        context: ComfyToolContext;
        tool: ComfyToolName;
        input: unknown;
        frozen: boolean;
      }
    | undefined;
  const fixture = await setup(async (context, tool, input) => {
    observed = { context, tool, input, frozen: Object.isFrozen(context) };
    return { workflows: ["basic"] };
  });
  try {
    const result = await call(fixture.bridge, listRequest, { fragment: true });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), {
      result: { workflows: ["basic"] },
    });
    assert.deepEqual(observed, {
      context: owner,
      tool: "paint_list_workflows",
      input: {},
      frozen: true,
    });
    const socket = await lstat(fixture.bridge.socketPath);
    assert.equal(socket.mode & 0o777, 0o600);
    const dir = await lstat(fixture.root);
    assert.equal(dir.mode & 0o777, 0o700);
  } finally {
    await fixture.bridge.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("bridge rejects forged owner, bad token, wrong operation/method and unknown fields", async () => {
  let executed = 0;
  const fixture = await setup(async () => {
    executed++;
    return {};
  });
  try {
    for (const [body, options, status] of [
      [{ ...listRequest, userId: owner.userId }, {}, 400],
      [{ ...listRequest, input: { userId: owner.userId } }, {}, 400],
      [{ tool: "paint_nope", input: {} }, {}, 400],
      [listRequest, { token: "0".repeat(64) }, 401],
      [listRequest, { method: "GET" }, 404],
      [listRequest, { path: "/wrong" }, 404],
    ] as const)
      assert.equal((await call(fixture.bridge, body, options)).status, status);
    assert.equal(executed, 0);
  } finally {
    await fixture.bridge.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("bridge rejects oversized body and oversized/non-JSON host results without disclosure", async () => {
  const secret = "/private/provider/path";
  let executed = 0;
  const fixture = await setup(async () => {
    executed++;
    if (executed === 1) throw new Error(secret);
    return "x".repeat(33 * 1024);
  });
  try {
    const oversized = await call(
      fixture.bridge,
      Buffer.from("x".repeat(COMFY_BRIDGE_MAX_BODY_BYTES + 1)).toString(),
    );
    assert.notEqual(oversized.status, 200);
    assert.equal((await call(fixture.bridge, listRequest)).status, 502);
    assert.equal((await call(fixture.bridge, listRequest)).status, 502);
    assert.ok(!(await readdir(fixture.parent)).includes("other"));
    assert.ok(
      !JSON.stringify(
        await Promise.all([
          readFile(fixture.bridge.socketPath).catch(() => Buffer.alloc(0)),
        ]),
      ).includes(secret),
    );
  } finally {
    await fixture.bridge.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("host error is sanitized; deadline aborts; close aborts and destroys pending requests", async () => {
  const secret = "/host/private/path";
  const fixture = await setup(async () => {
    throw new Error(secret);
  });
  try {
    const result = await call(fixture.bridge, listRequest);
    assert.equal(result.status, 502);
    assert.ok(!result.body.includes(secret));
    let deadlineAborted = false;
    const deadlineFixture = await setup(
      async (_ctx, _tool, _input, signal) =>
        new Promise(() =>
          signal?.addEventListener(
            "abort",
            () => {
              deadlineAborted = true;
            },
            { once: true },
          ),
        ),
    );
    const timeout = await call(deadlineFixture.bridge, listRequest);
    assert.equal(timeout.status, 504);
    assert.equal(deadlineAborted, true);
    await deadlineFixture.bridge.close();
    await rm(deadlineFixture.parent, { recursive: true, force: true });
    let signalAborted = false;
    const waiting = await setup(
      async (_ctx, _tool, _input, signal) =>
        new Promise(() =>
          signal?.addEventListener(
            "abort",
            () => {
              signalAborted = true;
            },
            { once: true },
          ),
        ),
    );
    const pending = call(waiting.bridge, listRequest).catch(() => ({
      status: 0,
      body: "",
    }));
    await delay(20);
    await waiting.bridge.close();
    await pending;
    assert.equal(signalAborted, true);
    assert.deepEqual(await readdir(waiting.parent), []);
    await rm(waiting.parent, { recursive: true, force: true });
  } finally {
    await fixture.bridge.close();
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
