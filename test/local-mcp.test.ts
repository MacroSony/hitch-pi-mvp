import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { readLocalMcpEnvironment } from "../src/local/mcp.js";
import { controlSocketPath, LocalControlServer } from "../src/local/socket.js";
import { LOCAL_METHODS } from "../src/local/types.js";
import type { LocalCallerConfig, LocalRequest } from "../src/local/types.js";

const EXPECTED_TOOLS = [
  "hitch_delivery_status",
  "hitch_notify",
  "hitch_schedule_cancel",
  "hitch_schedule_create",
  "hitch_schedule_list",
  "hitch_schedule_set_enabled",
  "hitch_targets",
];

function textOf(result: unknown): string {
  if (result === null || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        return (item as { text: string }).text;
      }
      return "";
    })
    .join("\n");
}

test("MCP reads only the three dedicated control variables", () => {
  const environment = readLocalMcpEnvironment({
    HITCH_CONTROL_SOCKET: "/run/hitch/control/hitch.sock",
    HITCH_CONTROL_CALLER: "operator",
    HITCH_CONTROL_TOKEN: "fixture-token",
    HITCH_TELEGRAM_TOKEN: "must-not-be-read",
    DATABASE_PATH: "/srv/hitch/data",
  });
  assert.deepEqual(environment, {
    socketPath: "/run/hitch/control/hitch.sock",
    callerId: "operator",
    token: "fixture-token",
  });
  assert.throws(() => readLocalMcpEnvironment({}), /HITCH_CONTROL_SOCKET/u);
  assert.throws(
    () => readLocalMcpEnvironment({ HITCH_CONTROL_SOCKET: "/s" }),
    /HITCH_CONTROL_CALLER/u,
  );
  assert.throws(
    () =>
      readLocalMcpEnvironment({
        HITCH_CONTROL_SOCKET: "/s",
        HITCH_CONTROL_CALLER: "operator",
      }),
    /HITCH_CONTROL_TOKEN/u,
  );
});

test("MCP stdio adapter lists and calls local control tools", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hitch-local-mcp-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot, { mode: 0o700 });
  const socketPath = controlSocketPath(dataRoot);
  const secret = randomBytes(48).toString("base64url");
  const requests: LocalRequest[] = [];
  const callerConfig: LocalCallerConfig = {
    id: "operator",
    tokenEnv: "HITCH_TEST_CONTROL_TOKEN",
    userIds: ["alice"],
    actions: [...LOCAL_METHODS],
  };
  const server = new LocalControlServer({
    socketPath,
    callers: [callerConfig],
    environment: { HITCH_TEST_CONTROL_TOKEN: secret },
    handler: (_caller, request) => {
      requests.push(request);
      return { method: request.method, params: request.params };
    },
  });
  await server.listen();

  const mcpPath = fileURLToPath(
    new URL("../src/local/mcp.js", import.meta.url),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--disable-warning=ExperimentalWarning", mcpPath],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HITCH_CONTROL_SOCKET: socketPath,
      HITCH_CONTROL_CALLER: "operator",
      HITCH_CONTROL_TOKEN: secret,
    },
    stderr: "pipe",
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk: Uint8Array) => {
    stderrChunks.push(Buffer.from(chunk));
  });
  const client = new Client(
    { name: "hitch-mcp-test", version: "1.0.0" },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    EXPECTED_TOOLS,
  );
  const scheduleCreateTool = listed.tools.find(
    (tool) => tool.name === "hitch_schedule_create",
  );
  assert.ok(scheduleCreateTool);
  assert.match(
    JSON.stringify(scheduleCreateTool.inputSchema),
    /Sorted ascending, unique weekdays/u,
  );

  const targets = await client.callTool({
    name: "hitch_targets",
    arguments: {},
  });
  assert.equal(targets.isError, undefined);
  assert.match(textOf(targets), /"method":"targets\.list"/u);

  const notify = await client.callTool({
    name: "hitch_notify",
    arguments: {
      requestId: "req-notify-1",
      userId: "alice",
      text: "literal hello",
    },
  });
  assert.equal(notify.isError, undefined);
  assert.deepEqual(
    requests.find((request) => request.method === "notify")?.params,
    {
      requestId: "req-notify-1",
      userId: "alice",
      text: "literal hello",
    },
  );

  const delivery = await client.callTool({
    name: "hitch_delivery_status",
    arguments: { userId: "alice", deliveryId: "delivery-1" },
  });
  assert.equal(delivery.isError, undefined);
  assert.deepEqual(
    requests.find((request) => request.method === "delivery.get")?.params,
    { userId: "alice", deliveryId: "delivery-1" },
  );

  const listedSchedules = await client.callTool({
    name: "hitch_schedule_list",
    arguments: { userId: "alice" },
  });
  assert.equal(listedSchedules.isError, undefined);
  assert.deepEqual(
    requests.find((request) => request.method === "schedule.list")?.params,
    { userId: "alice" },
  );

  const created = await client.callTool({
    name: "hitch_schedule_create",
    arguments: {
      requestId: "req-schedule-1",
      userId: "alice",
      action: "wake",
      sessionId: "session_alice",
      text: "wake up",
      recurrence: { kind: "weekly", weekdays: [1, 3, 5] },
      timeOfDay: "09:30",
      timezone: "Europe/Berlin",
    },
  });
  assert.equal(created.isError, undefined);
  assert.deepEqual(
    requests.find((request) => request.method === "schedule.create")?.params,
    {
      requestId: "req-schedule-1",
      userId: "alice",
      action: "wake",
      sessionId: "session_alice",
      text: "wake up",
      recurrence: { kind: "weekly", weekdays: [1, 3, 5] },
      timeOfDay: "09:30",
      timezone: "Europe/Berlin",
    },
  );

  const visible = [
    textOf(targets),
    textOf(notify),
    textOf(delivery),
    textOf(listedSchedules),
    textOf(created),
  ].join("\n");
  assert.ok(!visible.includes(secret));

  const unsorted = await client.callTool({
    name: "hitch_schedule_create",
    arguments: {
      requestId: "req-schedule-unsorted",
      userId: "alice",
      action: "notify",
      text: "unsorted weekdays",
      recurrence: { kind: "weekly", weekdays: [3, 1] },
      timeOfDay: "09:30",
      timezone: "Europe/Berlin",
    },
  });
  assert.equal(unsorted.isError, true);

  await client.close();
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  assert.ok(!stderr.includes(secret));
});
