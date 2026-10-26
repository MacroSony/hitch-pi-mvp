import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HitchApplication } from "../src/app/application.js";
import { HitchStore } from "../src/app/store.js";
import { DiscordWorker, type DiscordClient } from "../src/channels/discord.js";
import { ComfyBackendClient } from "../src/comfyui/client.js";
import { ComfyService } from "../src/comfyui/service.js";
import { ComfyWorkflowPolicy } from "../src/comfyui/workflow.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { MediaStore } from "../src/media/media-store.js";
import { FakeAgentRuntime } from "../src/runtime/runtime.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("Comfy background result survives Store restart and delivers one new rich group without replaying the source Turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hitch-comfy-delivery-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = (name: string) => {
    const p = join(root, name);
    mkdirSync(p, { mode: 0o700 });
    return p;
  };
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot: directory("data"),
    piProfileDir: directory("profile"),
    minimumFreeBytes: 0,
    telegramAccounts: [],
    wechatAccounts: [],
    discordAccounts: [{ id: "bot", botTokenEnv: "TEST_TOKEN" }],
    users: [
      {
        id: "owner",
        workspace: directory("owner"),
        discord: {
          mode: "dm",
          account: "bot",
          userId: "20000000000000001",
          channelId: "20000000000000021",
        },
      },
      {
        id: "foreign",
        workspace: directory("foreign"),
        discord: {
          mode: "dm",
          account: "bot",
          userId: "20000000000000002",
          channelId: "20000000000000022",
        },
      },
    ],
  });
  let foundation = bootstrapFoundation(config);
  t.after(() => foundation.close());
  let store = new HitchStore(foundation.database);
  const media = new MediaStore(config.dataRoot, 0);
  let submissions = 0,
    polls = 0;
  const backendServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/prompt") {
      for await (const _chunk of request) {
        /* consume bounded fixture request */
      }
      submissions += 1;
      response.end(JSON.stringify({ prompt_id: "private_backend_id" }));
    } else if (url.pathname === "/history/private_backend_id") {
      polls += 1;
      response.end(
        JSON.stringify({
          private_backend_id: {
            status: { completed: true, status_str: "success" },
            outputs: {
              "2": {
                images: [
                  { filename: "fixture.png", type: "output", subfolder: "" },
                ],
              },
            },
          },
        }),
      );
    } else if (url.pathname === "/view") {
      response.end(png);
    } else {
      response.writeHead(500);
      response.end();
    }
  });
  backendServer.listen(0, "127.0.0.1");
  await once(backendServer, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        backendServer.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = backendServer.address();
  assert.ok(address && typeof address === "object");
  const backend = new ComfyBackendClient({
    key: "fixture",
    origin: `http://127.0.0.1:${address.port}`,
    allowPrivate: true,
  });
  const policy = new ComfyWorkflowPolicy({
    id: "fixture",
    graph: {
      "1": { class_type: "PrimitiveString", inputs: { value: "test prompt" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    },
    variables: {
      prompt: { nodeId: "1", input: "value", type: "string", maxLength: 80 },
    },
    outputNodes: ["2"],
  });
  const service = () =>
    new ComfyService({
      ledger: store,
      media,
      backend,
      workflows: [policy],
      enabledUsers: ["owner", "foreign"],
    });
  const texts: string[] = [],
    rich: Array<{ channel: string; bytes: Buffer; reply?: string }> = [];
  const client: DiscordClient = {
    botUserId: "fixture-bot",
    assertHealthy() {},
    async connect() {},
    async close() {},
    async sendTyping() {},
    async fetchReferencedAuthor() {
      return null;
    },
    async sendText(_channel, text) {
      texts.push(text);
    },
    async downloadAttachment() {
      throw new Error("unused");
    },
    async sendArtifact() {
      assert.fail("expected rich completion");
    },
    async sendRichReply(channel, text, artifacts, objects, options) {
      assert.ok(text);
      assert.equal(artifacts.length, 1);
      rich.push({
        channel,
        bytes: readFileSync(objects.verifiedObjectPath(artifacts[0]!)),
        ...(options?.replyToMessageId === undefined
          ? {}
          : { reply: options.replyToMessageId }),
      });
    },
  };
  const worker = () =>
    new DiscordWorker(
      { id: "bot" },
      new HitchApplication(store, new FakeAgentRuntime()),
      store,
      { client, media },
    );
  const endpoint = store.resolveDiscordEndpoint(
    "bot",
    "dm",
    "20000000000000001",
    "20000000000000021",
  );
  assert.ok(endpoint);
  const source = {
    messageId: "30000000000000001",
    channelId: "20000000000000021",
    guildId: null,
    authorId: "20000000000000001",
    authorName: "fixture",
    timestamp: "2026-01-01T00:00:00Z",
  };
  const admitted = store.admitPrompt(
    {
      endpoint,
      idempotencyKey: "fixture-image-request",
      contentDigest: createHash("sha256")
        .update("fixture-image-request")
        .digest("hex"),
      discordSource: source,
    },
    "test prompt",
  );
  const turn = store.claimNextTurn("owner");
  assert.ok(turn);
  assert.equal(turn.turnId, admitted.turnId);
  let paint = service();
  const publicJob = (await paint.execute(
    { userId: "owner", turnId: turn.turnId },
    "paint",
    { workflow: "fixture", prompt: "test prompt" },
  )) as { id: string; state: string };
  assert.equal(publicJob.state, "submitted");
  assert.equal(submissions, 1);
  assert.ok(!JSON.stringify(publicJob).includes("private_backend_id"));
  await paint.tick();
  assert.equal(
    polls,
    0,
    "completion waits until the source model Turn is terminal",
  );
  store.completeTurn(turn, {
    outcome: "succeeded",
    text: "Job submitted.",
    sessionReusable: true,
  });
  await worker().deliverPending();
  assert.deepEqual(texts, ["Job submitted."]);
  assert.equal(rich.length, 0);
  foundation.close();
  foundation = bootstrapFoundation(config);
  store = new HitchStore(foundation.database);
  paint = service();
  paint.recover();
  assert.equal(store.getComfyJob("owner", publicJob.id)?.state, "submitted");
  assert.equal(store.getComfyJob("foreign", publicJob.id), null);
  assert.deepEqual(
    await paint.execute(
      { userId: "foreign", turnId: "unused" },
      "paint_job_status",
      { job_id: publicJob.id },
    ),
    [],
  );
  await paint.tick();
  await worker().deliverPending();
  assert.equal(store.getComfyJob("owner", publicJob.id)?.state, "completed");
  assert.equal(rich.length, 1);
  assert.equal(rich[0]?.channel, "20000000000000021");
  assert.equal(rich[0]?.reply, source.messageId);
  assert.deepEqual(rich[0]?.bytes, png);
  assert.deepEqual(
    texts,
    ["Job submitted."],
    "completion caption is combined, not sent separately",
  );
  const rows = foundation.database.connection
    .prepare("SELECT kind,state FROM outbox WHERE turn_id=? ORDER BY kind")
    .all(store.getComfyJob("owner", publicJob.id)!.completionTurnId!) as {
    kind: string;
    state: string;
  }[];
  assert.deepEqual(
    rows.map((r) => [r.kind, r.state]),
    [
      ["artifact", "sent"],
      ["text", "sent"],
    ],
  );
  const original = foundation.database.connection
    .prepare(
      "SELECT result_text,discord_source,session_id FROM turns WHERE id=?",
    )
    .get(turn.turnId) as {
    result_text: string;
    discord_source: string;
    session_id: string;
  };
  assert.equal(original.result_text, "Job submitted.");
  assert.deepEqual(JSON.parse(original.discord_source), source);
  assert.equal(original.session_id, turn.sessionId);
  await paint.tick();
  await worker().deliverPending();
  assert.equal(submissions, 1);
  assert.equal(polls, 1);
  assert.equal(rich.length, 1);
});
