import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { callLocal, LocalClientError } from "../src/local/client.js";
import {
  controlSocketPath,
  isValidLocalTokenLength,
  LOCAL_MAX_TOKEN_BYTES,
  LOCAL_MIN_TOKEN_BYTES,
  LocalControlServer,
} from "../src/local/socket.js";
import { LOCAL_METHODS, LocalControlError } from "../src/local/types.js";
import type {
  LocalCallerConfig,
  LocalHandler,
  LocalRequest,
} from "../src/local/types.js";

interface Layout {
  readonly root: string;
  readonly dataRoot: string;
  readonly socketPath: string;
}

function createLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), "hitch-local-socket-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot, { mode: 0o700 });
  return { root, dataRoot, socketPath: controlSocketPath(dataRoot) };
}

function token(): string {
  return randomBytes(48).toString("base64url");
}

function caller(overrides: Partial<LocalCallerConfig> = {}): LocalCallerConfig {
  return {
    id: "operator",
    tokenEnv: "HITCH_TEST_CONTROL_TOKEN",
    userIds: ["alice"],
    actions: [...LOCAL_METHODS],
    ...overrides,
  };
}

function environment(secret: string): NodeJS.ProcessEnv {
  return { HITCH_TEST_CONTROL_TOKEN: secret };
}

function makeServer(
  socketPath: string,
  handler: LocalHandler,
  secret: string,
  overrides: Partial<{
    requestTimeoutMs: number;
    maxConnections: number;
    callers: readonly LocalCallerConfig[];
  }> = {},
): LocalControlServer {
  return new LocalControlServer({
    socketPath,
    callers: overrides.callers ?? [caller()],
    handler,
    environment: environment(secret),
    ...(overrides.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: overrides.requestTimeoutMs }),
    ...(overrides.maxConnections === undefined
      ? {}
      : { maxConnections: overrides.maxConnections }),
  });
}

async function rawExchange(
  socketPath: string,
  payload: string | Buffer,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("raw exchange timed out"));
    }, 5_000);
    timer.unref?.();
    socket.on("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.indexOf(0x0a) === -1) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(buffer.toString("utf8"));
    });
    socket.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function requestLine(
  callerId: string,
  secret: string,
  method: string,
  params: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ v: 1, callerId, token: secret, method, params })}\n`;
}

/** Leaves a real but unserved Unix socket at `socketPath` using SIGKILL. */
async function leaveStaleSocket(socketPath: string): Promise<void> {
  const script = `const net = require("node:net"); const server = net.createServer(); server.listen(${JSON.stringify(socketPath)}, () => { console.log("READY"); });`;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectReady(new Error("stale socket child timed out"));
    }, 5_000);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes("READY")) return;
      clearTimeout(timer);
      resolveReady();
    });
    child.once("error", rejectReady);
    child.once("exit", (code) => {
      if (!output.includes("READY")) {
        clearTimeout(timer);
        rejectReady(
          new Error(`stale socket child exited early: ${String(code)}`),
        );
      }
    });
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  if (!lstatSync(socketPath).isSocket()) {
    throw new Error("stale socket fixture was not created");
  }
}

test("local control round-trips and denies authentication or actions", async (t) => {
  const layout = createLayout();
  const secret = token();
  const seen: { caller: string; request: LocalRequest }[] = [];
  const server = makeServer(
    layout.socketPath,
    (authentication, request) => {
      seen.push({ caller: authentication.id, request });
      if (request.method === "delivery.get") {
        throw new LocalControlError("not-found");
      }
      return { ok: true, method: request.method };
    },
    secret,
    {
      callers: [
        caller({ actions: ["targets.list", "notify", "delivery.get"] }),
      ],
    },
  );
  await server.listen();
  t.after(async () => {
    await server.close();
  });

  const directory = statSync(dirname(layout.socketPath));
  assert.equal(directory.mode & 0o777, 0o700);
  assert.equal(directory.uid, process.getuid?.());
  const socketMetadata = lstatSync(layout.socketPath);
  assert.ok(socketMetadata.isSocket());
  assert.equal(socketMetadata.mode & 0o777, 0o600);

  const result = await callLocal(layout.socketPath, "operator", secret, {
    method: "targets.list",
    params: {},
  });
  assert.deepEqual(result, { ok: true, method: "targets.list" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.caller, "operator");

  await assert.rejects(
    () =>
      callLocal(layout.socketPath, "operator", secret, {
        method: "schedule.cancel",
        params: {},
      }),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "forbidden",
  );
  await assert.rejects(
    () =>
      callLocal(layout.socketPath, "operator", "x".repeat(64), {
        method: "targets.list",
        params: {},
      }),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "rejected",
  );
  await assert.rejects(
    () =>
      callLocal(layout.socketPath, "stranger", secret, {
        method: "targets.list",
        params: {},
      }),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "rejected",
  );
  await assert.rejects(
    () =>
      callLocal(layout.socketPath, "operator", secret, {
        method: "delivery.get",
        params: { requestId: "req-1" },
      }),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "not-found",
  );
});

test("local control enforces configured token byte bounds without entropy scoring", async () => {
  assert.equal(isValidLocalTokenLength("short"), false);
  assert.equal(isValidLocalTokenLength("a".repeat(64)), true);
  assert.equal(isValidLocalTokenLength(token()), true);
  assert.equal(
    isValidLocalTokenLength("a".repeat(LOCAL_MAX_TOKEN_BYTES)),
    true,
  );
  assert.equal(
    isValidLocalTokenLength("a".repeat(LOCAL_MAX_TOKEN_BYTES + 1)),
    false,
  );
  assert.equal(LOCAL_MIN_TOKEN_BYTES, 32);
  assert.equal(LOCAL_MAX_TOKEN_BYTES, 4 * 1024);

  const layout = createLayout();
  for (const secret of ["short", "a".repeat(LOCAL_MAX_TOKEN_BYTES + 1)]) {
    const server = makeServer(layout.socketPath, () => null, secret);
    await assert.rejects(
      () => server.listen(),
      /must be 32\.\.4096 UTF-8 bytes/u,
    );
    assert.equal(server.listening, false);
  }
});

test("local control refuses files and symlinks at the socket path", async () => {
  const layout = createLayout();
  mkdirSync(dirname(layout.socketPath), { recursive: true, mode: 0o700 });
  writeFileSync(layout.socketPath, "not a socket", { mode: 0o600 });
  const fileServer = makeServer(layout.socketPath, () => null, token());
  await assert.rejects(() => fileServer.listen(), /non-socket/u);

  rmSync(layout.socketPath);
  symlinkSync("/tmp", layout.socketPath);
  const linkServer = makeServer(layout.socketPath, () => null, token());
  await assert.rejects(() => linkServer.listen(), /symlink/u);
});

test("local control never replaces an active socket", async (t) => {
  const layout = createLayout();
  const secret = token();
  const active = makeServer(layout.socketPath, () => "active", secret);
  await active.listen();
  t.after(async () => {
    await active.close();
  });

  const contender = makeServer(layout.socketPath, () => "contender", secret);
  await assert.rejects(() => contender.listen(), /active/u);
  assert.equal(
    await callLocal(layout.socketPath, "operator", secret, {
      method: "targets.list",
      params: {},
    }),
    "active",
  );
});

test("local control cleans a proven-stale socket and binds again", async (t) => {
  const layout = createLayout();
  mkdirSync(dirname(layout.socketPath), { recursive: true, mode: 0o700 });
  await leaveStaleSocket(layout.socketPath);

  const secret = token();
  const server = makeServer(layout.socketPath, () => "recovered", secret);
  await server.listen();
  t.after(async () => {
    await server.close();
  });
  assert.equal(
    await callLocal(layout.socketPath, "operator", secret, {
      method: "targets.list",
      params: {},
    }),
    "recovered",
  );
});

test("local control bounds request size and request time", async (t) => {
  const layout = createLayout();
  const secret = token();
  const server = makeServer(
    layout.socketPath,
    (): Promise<never> => new Promise<never>(() => {}),
    secret,
    { requestTimeoutMs: 300 },
  );
  await server.listen();
  t.after(async () => {
    await server.close();
  });

  const oversized = await rawExchange(layout.socketPath, "a".repeat(70 * 1024));
  assert.match(oversized, /"error":"rejected"/u);
  assert.ok(!oversized.includes("aaaa"));

  await assert.rejects(
    () =>
      callLocal(
        layout.socketPath,
        "operator",
        secret,
        { method: "targets.list", params: {} },
        { timeoutMs: 2_000 },
      ),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "rejected",
  );
});

test("local control caps simultaneous connections", async (t) => {
  const layout = createLayout();
  const secret = token();
  const server = makeServer(layout.socketPath, () => "ok", secret, {
    maxConnections: 1,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
  });

  const idle = await new Promise<Socket>((resolveConnect, rejectConnect) => {
    const socket = createConnection({ path: layout.socketPath });
    socket.once("connect", () => resolveConnect(socket));
    socket.once("error", rejectConnect);
  });
  try {
    let capped = "";
    try {
      capped = await rawExchange(
        layout.socketPath,
        requestLine("operator", secret, "targets.list"),
      );
    } catch {
      capped = "";
    }
    assert.ok(!capped.includes('"ok":true'));
  } finally {
    idle.destroy();
  }
});

test("local control failures never echo credentials or bodies", async () => {
  const layout = createLayout();
  const secret = token();
  const server = makeServer(layout.socketPath, () => "unused", secret, {
    callers: [caller({ actions: ["targets.list"] })],
  });
  await server.listen();
  try {
    const malformed = await rawExchange(layout.socketPath, "{not json\n");
    assert.equal(malformed, '{"v":1,"ok":false,"error":"rejected"}\n');
    assert.ok(!malformed.includes("{not json"));

    const denied = await rawExchange(
      layout.socketPath,
      requestLine("operator", secret, "schedule.cancel"),
    );
    assert.equal(denied, '{"v":1,"ok":false,"error":"forbidden"}\n');
    assert.ok(!denied.includes(secret));

    const badAuth = await rawExchange(
      layout.socketPath,
      requestLine("operator", "z".repeat(64), "targets.list"),
    );
    assert.equal(badAuth, '{"v":1,"ok":false,"error":"rejected"}\n');
    assert.ok(!badAuth.includes(secret));
  } finally {
    await server.close();
  }
});

test("local control requires an exact request envelope and bounded caller ids", async () => {
  const layout = createLayout();
  const secret = token();
  const server = makeServer(layout.socketPath, () => "unused", secret, {
    callers: [caller({ actions: ["targets.list"] })],
  });
  await server.listen();
  try {
    const valid = { v: 1, callerId: "operator", token: secret };
    const cases: readonly [string, Record<string, unknown>][] = [
      ["missing params", { ...valid, method: "targets.list" }],
      [
        "missing v",
        {
          callerId: "operator",
          token: secret,
          method: "targets.list",
          params: {},
        },
      ],
      [
        "extra key",
        { ...valid, method: "targets.list", params: {}, extra: true },
      ],
      ["wrong v", { ...valid, v: 2, method: "targets.list", params: {} }],
      [
        "invalid caller id",
        {
          ...valid,
          callerId: "bad caller",
          method: "targets.list",
          params: {},
        },
      ],
      [
        "too-long caller id",
        {
          ...valid,
          callerId: "a".repeat(65),
          method: "targets.list",
          params: {},
        },
      ],
      ["null params", { ...valid, method: "targets.list", params: null }],
      ["array params", { ...valid, method: "targets.list", params: [] }],
      [
        "short token",
        { ...valid, token: "short", method: "targets.list", params: {} },
      ],
      [
        "too-long token",
        {
          ...valid,
          token: "x".repeat(LOCAL_MAX_TOKEN_BYTES + 1),
          method: "targets.list",
          params: {},
        },
      ],
    ];
    for (const [name, body] of cases) {
      const response = await rawExchange(
        layout.socketPath,
        `${JSON.stringify(body)}\n`,
      );
      assert.equal(response, '{"v":1,"ok":false,"error":"rejected"}\n', name);
    }
  } finally {
    await server.close();
  }
});

test("local control close during async listen never opens the listener", async () => {
  const layout = createLayout();
  const server = makeServer(layout.socketPath, () => "unexpected", token());
  const listening = server.listen();
  const closed = server.close();
  await assert.rejects(listening, /already been closed/u);
  await closed;
  assert.equal(server.listening, false);
  assert.equal(existsSync(layout.socketPath), false);
});

test("local control client reports stable errors without connecting", async () => {
  const layout = createLayout();
  const secret = token();
  await assert.rejects(
    () =>
      callLocal(
        layout.socketPath,
        "operator",
        "x".repeat(LOCAL_MAX_TOKEN_BYTES + 1),
        { method: "targets.list", params: {} },
      ),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "protocol",
  );
  await assert.rejects(
    () =>
      callLocal(layout.socketPath, "operator", secret, {
        method: "targets.list",
        params: {},
      }),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "connection",
  );
  await assert.rejects(
    () =>
      callLocal(layout.socketPath, "bad caller", secret, {
        method: "targets.list",
        params: {},
      }),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "protocol",
  );
  await assert.rejects(
    () =>
      callLocal(
        layout.socketPath,
        "operator",
        secret,
        { method: "notify", params: { text: "x".repeat(70 * 1024) } },
        { maxRequestBytes: 64 * 1024 },
      ),
    (error: unknown) =>
      error instanceof LocalClientError && error.code === "too-large",
  );
});
