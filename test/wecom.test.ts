import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchApplication } from "../src/app/application.js";
import { HitchStore } from "../src/app/store.js";
import {
  WeComError,
  WeComWorker,
  readWeComCredentials,
} from "../src/channels/wecom.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { MediaStore } from "../src/media/media-store.js";
import { FakeAgentRuntime, type RuntimeTurn } from "../src/runtime/runtime.js";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await wait(5);
  }
}

class FakeWeComSocket extends EventEmitter {
  public readonly sent: Record<string, unknown>[] = [];
  public terminateCalled = false;
  public autoAck = true;
  public ackErrcode = 0;
  public subscribeErrcode: number | undefined;
  #opened = false;

  public constructor() {
    super();
    queueMicrotask(() => this.open());
  }

  public open(): void {
    if (this.#opened) return;
    this.#opened = true;
    this.emit("open");
  }

  public send(data: string): void {
    const frame = JSON.parse(String(data)) as {
      headers?: { req_id?: string };
      cmd?: string;
    };
    this.sent.push(frame);
    if (!this.autoAck) return;
    const reqId = frame.headers?.req_id;
    if (reqId === undefined) return;
    let errcode = this.ackErrcode;
    if (frame.cmd === "aibot_subscribe" && this.subscribeErrcode !== undefined)
      errcode = this.subscribeErrcode;
    queueMicrotask(() => {
      this.emit(
        "message",
        JSON.stringify({
          headers: { req_id: reqId },
          errcode,
          errmsg: errcode === 0 ? "ok" : "rejected",
        }),
      );
    });
  }

  public push(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }

  public pushRaw(data: string): void {
    this.emit("message", data);
  }

  public drop(): void {
    this.emit("close");
  }

  public terminate(): void {
    this.terminateCalled = true;
  }

  public sentCmd(cmd: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.cmd === cmd);
  }
}

function callback(
  msgid: string,
  text: string,
  options: {
    botId?: string;
    chattype?: string;
    msgtype?: string;
    userId?: string;
  } = {},
): Record<string, unknown> {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: `server-${msgid}` },
    body: {
      msgid,
      aibotid: options.botId ?? "bot-test",
      chattype: options.chattype ?? "single",
      msgtype: options.msgtype ?? "text",
      from: { userid: options.userId ?? "wc-alice" },
      text: { content: text },
    },
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hitch-wecom-test-"));
  chmodSync(root, 0o700);
  const paths = {
    data: join(root, "data"),
    pi: join(root, "pi"),
    alice: join(root, "alice"),
  };
  for (const path of [paths.pi, paths.alice]) privateDirectory(path);
  const credentialsFile = join(root, "wecom-credentials.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({ botId: "bot-test", secret: "secret-test" }),
    { mode: 0o600 },
  );
  const foundation = bootstrapFoundation(
    parseConfig({
      schemaVersion: 1,
      dataRoot: paths.data,
      piProfileDir: paths.pi,
      minimumFreeBytes: 0,
      telegramAccounts: [],
      wechatAccounts: [],
      wecomAccounts: [{ id: "enterprise", credentialsFile }],
      users: [
        {
          id: "alice",
          workspace: paths.alice,
          wecom: { account: "enterprise", userId: "wc-alice" },
        },
      ],
    }),
  );
  const media = new MediaStore(paths.data);
  const store = new HitchStore(
    foundation.database,
    undefined,
    undefined,
    (userId) => media.assertAdmissionCapacity(userId),
  );
  const calls: RuntimeTurn[] = [];
  const app = new HitchApplication(
    store,
    new FakeAgentRuntime((turn) => {
      calls.push(turn);
      return { outcome: "succeeded", text: "ok", sessionReusable: true };
    }),
    "always-trigger",
    undefined,
    undefined,
    root,
  );
  app.start();
  const sockets: FakeWeComSocket[] = [];
  let nextSubscribeErrcode: number | undefined;
  const worker = new WeComWorker("enterprise", credentialsFile, app, store, {
    socketFactory: () => {
      const socket = new FakeWeComSocket();
      if (nextSubscribeErrcode !== undefined) {
        socket.subscribeErrcode = nextSubscribeErrcode;
        nextSubscribeErrcode = undefined;
      }
      sockets.push(socket);
      return socket;
    },
    heartbeatMs: 40,
    ackTimeoutMs: 200,
    deliverPollMs: 10,
    sendGapMs: 1,
    reconnectBaseMs: 20,
  });
  return {
    app,
    credentialsFile,
    foundation,
    root,
    sockets,
    store,
    worker,
    calls,
    failNextSubscribe(errcode: number): void {
      nextSubscribeErrcode = errcode;
    },
  };
}

type Environment = ReturnType<typeof setup>;

async function startWorker(environment: Environment): Promise<{
  controller: AbortController;
  done: Promise<void>;
}> {
  const controller = new AbortController();
  const done = environment.worker.run(controller.signal);
  done.catch(() => undefined);
  await waitFor(
    () =>
      environment.sockets.length > 0 &&
      environment.sockets[0]!.sentCmd("aibot_subscribe").length === 1,
    "subscribe",
  );
  return { controller, done };
}

function insertTextOutbox(
  environment: Environment,
  text: string,
  id = `outbox-${Math.random().toString(16).slice(2)}`,
): void {
  const endpoint = environment.store.resolveWeComEndpoint(
    "enterprise",
    "wc-alice",
  );
  assert.notEqual(endpoint, null);
  const now = Date.now();
  environment.foundation.database.connection
    .prepare(
      `INSERT INTO outbox(
         id, user_id, endpoint_id, turn_id, kind, payload_text, state, attempts, created_at, updated_at
       ) VALUES (?, 'alice', ?, NULL, 'text', ?, 'pending', 0, ?, ?)`,
    )
    .run(id, endpoint!.id, text, now, now);
}

function outboxState(environment: Environment, id: string): string {
  const row = environment.foundation.database.connection
    .prepare("SELECT state FROM outbox WHERE id = ?")
    .get(id) as { state: string } | undefined;
  assert.notEqual(row, undefined);
  return row!.state;
}

test("WeCom worker subscribes, heartbeats, and keeps one connection", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  const subscribe = socket.sentCmd("aibot_subscribe")[0] as {
    body: { bot_id: string; secret: string };
  };
  assert.deepEqual(subscribe.body, {
    bot_id: "bot-test",
    secret: "secret-test",
  });
  await wait(150);
  assert.ok(
    socket.sentCmd("aibot_heartbeat").length >= 2,
    "heartbeat frames repeat",
  );
  assert.equal(environment.sockets.length, 1);
  controller.abort();
  await done;
  assert.equal(socket.terminateCalled, true);
  assert.equal(environment.sockets.length, 1);
  environment.foundation.close();
});

test("WeCom inbound text admits a Turn, dedupes, and delivers the result", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.push(callback("m-1", "hello"));
  await waitFor(() => environment.calls.length === 1, "turn admitted");
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 1,
    "result delivered",
  );
  const sent = socket.sentCmd("aibot_send_msg")[0] as {
    body: {
      chat_type: number;
      chatid: string;
      msgtype: string;
      markdown: { content: string };
    };
  };
  assert.deepEqual(
    [sent.body.chat_type, sent.body.chatid, sent.body.msgtype],
    [1, "wc-alice", "markdown"],
  );
  assert.match(sent.body.markdown.content, /ok/);
  socket.push(callback("m-1", "hello"));
  await wait(100);
  assert.equal(environment.calls.length, 1);
  assert.equal(socket.sentCmd("aibot_send_msg").length, 1);
  assert.equal(environment.store.pendingWeComOutbox("enterprise").length, 0);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom rejects unknown users silently and answers known-user media rejections", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.push(callback("m-2", "hello", { userId: "wc-mallory" }));
  await wait(100);
  assert.equal(socket.sentCmd("aibot_send_msg").length, 0);
  assert.equal(environment.calls.length, 0);

  socket.push(callback("m-3", "hello", { msgtype: "image" }));
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 1,
    "media reply",
  );
  const sent = socket.sentCmd("aibot_send_msg").at(-1) as {
    body: { chatid: string; markdown: { content: string } };
  };
  assert.equal(sent.body.chatid, "wc-alice");
  assert.match(
    sent.body.markdown.content,
    /Enterprise WeChat media is not supported yet/,
  );

  socket.push(callback("m-4", "hello", { chattype: "group" }));
  socket.push(callback("m-5", "hello", { botId: "different-bot" }));
  await wait(100);
  assert.equal(socket.sentCmd("aibot_send_msg").length, 1);
  assert.equal(environment.calls.length, 0);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom commands acknowledge and respond through the outbox", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.push(callback("m-6", "!status"));
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length >= 1,
    "status reply",
  );
  const contents = socket
    .sentCmd("aibot_send_msg")
    .map(
      (frame) =>
        (frame.body as { markdown: { content: string } }).markdown.content,
    )
    .join("\n");
  assert.match(contents, /active 0; queued 0/);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom outbox chunks long text and marks it sent", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  insertTextOutbox(environment, "x".repeat(7_000), "outbox-long");
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 3,
    "chunked delivery",
  );
  const chunks = socket
    .sentCmd("aibot_send_msg")
    .map(
      (frame) =>
        (frame.body as { markdown: { content: string } }).markdown.content
          .length,
    );
  assert.deepEqual(chunks, [3_000, 3_000, 1_000]);
  await waitFor(
    () => outboxState(environment, "outbox-long") === "sent",
    "outbox sent",
  );
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom artifact outbox fails clearly instead of hanging", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  const endpoint = environment.store.resolveWeComEndpoint(
    "enterprise",
    "wc-alice",
  );
  assert.notEqual(endpoint, null);
  const now = Date.now();
  environment.foundation.database.connection
    .prepare(
      `INSERT INTO artifacts(
         id, user_id, storage_key, sha256, bytes, media_kind, mime_type,
         display_name, created_at
       ) VALUES ('artifact-1', 'alice', 'wecom/test/artifact-1', ?, 3, 'file', 'text/plain', 'a.txt', ?)`,
    )
    .run("ab".repeat(32), now);
  environment.foundation.database.connection
    .prepare(
      `INSERT INTO outbox(
         id, user_id, endpoint_id, turn_id, artifact_id, kind, payload_text,
         state, attempts, created_at, updated_at
       ) VALUES ('outbox-artifact', 'alice', ?, NULL, 'artifact-1', 'artifact', NULL, 'pending', 0, ?, ?)`,
    )
    .run(endpoint!.id, now, now);
  await waitFor(
    () => outboxState(environment, "outbox-artifact") === "failed",
    "artifact failed",
  );
  assert.equal(socket.sentCmd("aibot_send_msg").length, 0);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom send failure retries through a fresh connection", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.ackErrcode = 500;
  insertTextOutbox(environment, "retry me", "outbox-retry");
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 1,
    "failed send attempt",
  );
  await waitFor(
    () => environment.sockets.length === 2,
    "reconnect after send failure",
  );
  const replacement = environment.sockets[1]!;
  await waitFor(
    () => outboxState(environment, "outbox-retry") === "sent",
    "retry delivered",
  );
  assert.equal(replacement.sentCmd("aibot_send_msg").length >= 1, true);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom authentication failure is fatal and does not reconnect", async () => {
  const environment = setup();
  environment.failNextSubscribe(853000);
  const controller = new AbortController();
  const done = environment.worker.run(controller.signal);
  await assert.rejects(done, (error: unknown) => {
    assert.ok(error instanceof WeComError);
    assert.equal(error.fatal, true);
    return true;
  });
  await wait(100);
  assert.equal(environment.sockets.length, 1);
  controller.abort();
  environment.foundation.close();
});

test("WeCom disconnected_event is fatal and does not reconnect", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  environment.sockets[0]!.push({
    cmd: "aibot_event_callback",
    headers: { req_id: "event-1" },
    body: { event: { eventtype: "disconnected_event" } },
  });
  await assert.rejects(done, (error: unknown) => {
    assert.ok(error instanceof WeComError);
    assert.equal(error.fatal, true);
    return true;
  });
  await wait(100);
  assert.equal(environment.sockets.length, 1);
  controller.abort();
  environment.foundation.close();
});

test("WeCom reconnects and resubscribes after a dropped connection", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  environment.sockets[0]!.drop();
  await waitFor(
    () =>
      environment.sockets.length === 2 &&
      environment.sockets[1]!.sentCmd("aibot_subscribe").length === 1,
    "resubscribe",
  );
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom treats a missing heartbeat ack as a dead connection", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  environment.sockets[0]!.autoAck = false;
  await waitFor(() => environment.sockets.length === 2, "heartbeat reconnect");
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom ignores malformed frames and server-initiated heartbeats", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.pushRaw("this is not json{");
  socket.push({ cmd: "aibot_heartbeat", headers: { req_id: "ping_1" } });
  socket.push({ headers: {} });
  await wait(100);
  assert.equal(environment.sockets.length, 1);
  assert.equal(environment.calls.length, 0);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom credentials require a strict private JSON file", () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-wecom-creds-"));
  chmodSync(root, 0o700);
  const good = join(root, "good.json");
  writeFileSync(good, JSON.stringify({ botId: "bot-1", secret: "secret-1" }), {
    mode: 0o600,
  });
  assert.deepEqual(readWeComCredentials(good), {
    botId: "bot-1",
    secret: "secret-1",
  });

  const permissive = join(root, "permissive.json");
  writeFileSync(
    permissive,
    JSON.stringify({ botId: "bot-1", secret: "secret-1" }),
    { mode: 0o644 },
  );
  assert.throws(() => readWeComCredentials(permissive), WeComError);

  const linked = join(root, "linked.json");
  linkSync(good, linked);
  assert.throws(() => readWeComCredentials(linked), WeComError);

  const malformed = join(root, "malformed.json");
  writeFileSync(malformed, "not json", { mode: 0o600 });
  assert.throws(() => readWeComCredentials(malformed), WeComError);

  const extra = join(root, "extra.json");
  writeFileSync(
    extra,
    JSON.stringify({ botId: "bot-1", secret: "secret-1", token: "x" }),
    { mode: 0o600 },
  );
  assert.throws(() => readWeComCredentials(extra), WeComError);

  const missing = join(root, "missing.json");
  writeFileSync(missing, JSON.stringify({ botId: "bot-1" }), { mode: 0o600 });
  assert.throws(() => readWeComCredentials(missing), WeComError);

  const placeholder = join(root, "placeholder.json");
  writeFileSync(
    placeholder,
    JSON.stringify({ botId: "bot-1", secret: "REPLACE_ME" }),
    { mode: 0o600 },
  );
  assert.throws(() => readWeComCredentials(placeholder), WeComError);

  assert.throws(() => readWeComCredentials(root), WeComError);
  assert.throws(
    () => readWeComCredentials(join(root, "absent.json")),
    WeComError,
  );
});
