import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { HitchStore } from "../src/app/store.js";
import { HitchApplication } from "../src/app/application.js";
import { FakeAgentRuntime } from "../src/runtime/runtime.js";
import { createLocalHandler } from "../src/local/control.js";
import { controlSocketPath, LocalControlServer } from "../src/local/socket.js";
import { LOCAL_METHODS } from "../src/local/types.js";

// Full local control path, but no real provider or channel: notifications stop
// at the durable outbox. This is not an attended IM delivery test.
test(
  "stdio MCP -> authenticated socket -> real store/scheduler persists one delivery per request",
  { timeout: 20_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hitch-local-integration-"));
    const dataRoot = join(root, "data");
    const workspace = join(root, "workspace");
    const piProfileDir = join(root, "profile");
    for (const path of [workspace, piProfileDir])
      mkdirSync(path, { mode: 0o700 });
    const foundation = bootstrapFoundation(
      parseConfig({
        schemaVersion: 1,
        dataRoot,
        piProfileDir,
        minimumFreeBytes: 0,
        telegramAccounts: [{ id: "test", botTokenEnv: "UNUSED_FIXTURE_TOKEN" }],
        wechatAccounts: [],
        users: [
          {
            id: "alice",
            workspace,
            telegram: { account: "test", userId: "101", privateChatId: "101" },
          },
        ],
      }),
    );
    const store = new HitchStore(foundation.database);
    let modelCalls = 0;
    const app = new HitchApplication(
      store,
      new FakeAgentRuntime(() => {
        modelCalls++;
        return { outcome: "succeeded", text: "unused", sessionReusable: true };
      }),
      "always-trigger",
      undefined,
      30000,
      join(dataRoot, "users"),
    );
    const token = randomBytes(32).toString("hex");
    const socketPath = controlSocketPath(dataRoot);
    const server = new LocalControlServer({
      socketPath,
      callers: [
        {
          id: "mika",
          tokenEnv: "FIXTURE_KEY",
          userIds: ["alice"],
          actions: LOCAL_METHODS,
        },
      ],
      environment: { FIXTURE_KEY: token },
      handler: createLocalHandler(store, app),
    });
    const client = new Client({ name: "fixture", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--disable-warning=ExperimentalWarning",
        fileURLToPath(new URL("../src/local/mcp.js", import.meta.url)),
      ],
      env: {
        HITCH_CONTROL_SOCKET: socketPath,
        HITCH_CONTROL_CALLER: "mika",
        HITCH_CONTROL_TOKEN: token,
      },
      stderr: "pipe",
    });
    try {
      await server.listen();
      await client.connect(transport);
      async function call(
        name: string,
        args: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true);
        const content = result.content as Array<{ type: string; text: string }>;
        return JSON.parse(content.map((x) => x.text).join("\n")) as Record<
          string,
          unknown
        >;
      }
      assert.equal((await client.listTools()).tools.length, 7);
      const params = {
        requestId: "notice-1",
        userId: "alice",
        text: "literal {{date}}",
      };
      const first = await call("hitch_notify", params);
      const again = await call("hitch_notify", params);
      assert.equal(first.deliveryId, again.deliveryId);
      assert.equal(again.duplicate, true);
      assert.equal(store.pendingTelegramOutbox("test").length, 1);
      const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const schedule = await call("hitch_schedule_create", {
        requestId: "reminder-1",
        userId: "alice",
        action: "notify",
        text: "scheduled {{date}}",
        timeOfDay: "00:00",
        timezone: "UTC",
        recurrence: { kind: "once", date },
      });
      await call("hitch_schedule_set_enabled", {
        requestId: "pause-1",
        userId: "alice",
        scheduleId: schedule.scheduleId,
        enabled: false,
      });
      app.runWakeTick(Date.parse(`${date}T00:00:00Z`));
      assert.equal(store.pendingTelegramOutbox("test").length, 1);
      await call("hitch_schedule_set_enabled", {
        requestId: "resume-1",
        userId: "alice",
        scheduleId: schedule.scheduleId,
        enabled: true,
      });
      app.runWakeTick(Date.parse(`${date}T00:00:00Z`));
      app.runWakeTick(Date.parse(`${date}T00:00:00Z`));
      assert.deepEqual(
        store
          .pendingTelegramOutbox("test")
          .map((x) => x.text)
          .sort(),
        ["literal {{date}}", "scheduled {{date}}"],
      );
      assert.equal(modelCalls, 0);
      const status = await call("hitch_delivery_status", {
        userId: "alice",
        deliveryId: first.deliveryId,
      });
      assert.equal(status.status, "pending");
      await call("hitch_schedule_cancel", {
        requestId: "cancel-1",
        userId: "alice",
        scheduleId: schedule.scheduleId,
      });
      const listed = await call("hitch_schedule_list", { userId: "alice" });
      assert.equal(
        (listed.schedules as Array<{ textPreview: string }>)[0]?.textPreview,
        "scheduled {{date}}",
      );
      assert.equal(
        (listed.schedules as Array<{ cancelled: boolean }>)[0]?.cancelled,
        true,
      );
      const denied = await client.callTool({
        name: "hitch_notify",
        arguments: { ...params, userId: "bob" },
      });
      assert.equal(denied.isError, true);
      assert.ok(!JSON.stringify(denied).includes(token));
    } finally {
      await client.close();
      await server.close();
      app.stop();
      await app.drain();
      foundation.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
