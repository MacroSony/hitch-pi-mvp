import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
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
import { parseWeComDispositionFilename } from "../src/channels/wecom-media.js";
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
  public autoPong = true;
  public pingCount = 0;
  public ackErrcode = 0;
  public subscribeErrcode: number | undefined;
  public ackBodies: Record<string, unknown> = {};
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
    const body =
      frame.cmd === undefined ? undefined : this.ackBodies[frame.cmd];
    queueMicrotask(() => {
      this.emit(
        "message",
        JSON.stringify({
          headers: { req_id: reqId },
          errcode,
          errmsg: errcode === 0 ? "ok" : "rejected",
          ...(body === undefined ? {} : { body }),
        }),
      );
    });
  }

  public ping(): void {
    this.pingCount += 1;
    if (this.autoPong) queueMicrotask(() => this.emit("pong"));
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
    image?: unknown;
    file?: unknown;
    video?: unknown;
    voice?: unknown;
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
      ...(options.image === undefined ? {} : { image: options.image }),
      ...(options.file === undefined ? {} : { file: options.file }),
      ...(options.video === undefined ? {} : { video: options.video }),
      ...(options.voice === undefined ? {} : { voice: options.voice }),
    },
  };
}

const MEDIA_KEY = Buffer.alloc(32, 7);
const MEDIA_AESKEY = MEDIA_KEY.toString("base64");

function encryptMedia(plain: Buffer): Buffer {
  const padLen = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv(
    "aes-256-cbc",
    MEDIA_KEY,
    MEDIA_KEY.subarray(0, 16),
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

// 1x1 PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function setup(
  options: { mediaMode?: "always-trigger" | "text-trigger" } = {},
) {
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
  let clockNow = 1_700_000_000_000;
  const store = new HitchStore(
    foundation.database,
    undefined,
    { now: () => clockNow },
    (userId) => media.assertAdmissionCapacity(userId),
  );
  const calls: RuntimeTurn[] = [];
  const app = new HitchApplication(
    store,
    new FakeAgentRuntime((turn) => {
      calls.push(turn);
      return { outcome: "succeeded", text: "ok", sessionReusable: true };
    }),
    options.mediaMode ?? "always-trigger",
    media,
    undefined,
    root,
  );
  app.start();
  const sockets: FakeWeComSocket[] = [];
  const downloads: string[] = [];
  let downloadData: Buffer = encryptMedia(PNG_BYTES);
  let downloadFilename: string | undefined;
  let nextSubscribeErrcode: number | undefined;
  const worker = new WeComWorker(
    "enterprise",
    credentialsFile,
    app,
    store,
    media,
    {
      socketFactory: () => {
        const socket = new FakeWeComSocket();
        if (nextSubscribeErrcode !== undefined) {
          socket.subscribeErrcode = nextSubscribeErrcode;
          nextSubscribeErrcode = undefined;
        }
        sockets.push(socket);
        return socket;
      },
      downloadFn: async (url) => {
        downloads.push(url);
        return {
          data: downloadData,
          ...(downloadFilename === undefined
            ? {}
            : { filename: downloadFilename }),
        };
      },
      heartbeatMs: 40,
      ackTimeoutMs: 200,
      deliverPollMs: 10,
      sendGapMs: 1,
      reconnectBaseMs: 20,
      pingMs: 15,
      livenessLimitMs: 120,
    },
  );
  return {
    app,
    credentialsFile,
    downloads,
    foundation,
    media,
    root,
    sockets,
    store,
    worker,
    calls,
    setDownloadData(data: Buffer): void {
      downloadData = data;
    },
    setDownloadFilename(filename: string): void {
      downloadFilename = filename;
    },
    advanceClock(ms: number): void {
      clockNow += ms;
    },
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
  const heartbeats = socket.sentCmd("ping");
  assert.ok(heartbeats.length >= 2, "heartbeat frames repeat");
  assert.ok(
    heartbeats.every((frame) => !("body" in frame)),
    "heartbeat frames carry no body",
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

test("WeCom rejects unknown users silently and mixed messages with a reply", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.push(
    callback("m-2", "", {
      userId: "wc-mallory",
      msgtype: "image",
      image: { url: "https://example.test/x", aeskey: MEDIA_AESKEY },
    }),
  );
  await wait(100);
  assert.equal(socket.sentCmd("aibot_send_msg").length, 0);
  assert.equal(environment.calls.length, 0);
  assert.equal(environment.downloads.length, 0, "no download for unknown user");

  socket.push(callback("m-3", "hello", { msgtype: "mixed" }));
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 1,
    "mixed reply",
  );
  const sent = socket.sentCmd("aibot_send_msg").at(-1) as {
    body: { chatid: string; markdown: { content: string } };
  };
  assert.equal(sent.body.chatid, "wc-alice");
  assert.match(
    sent.body.markdown.content,
    /Enterprise WeChat mixed messages are not supported yet/,
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

test("WeCom downloads, decrypts, and admits image/file/video media", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.push(
    callback("m-10", "", {
      msgtype: "image",
      image: { url: "https://example.test/image", aeskey: MEDIA_AESKEY },
    }),
  );
  await waitFor(() => environment.calls.length === 1, "image turn");
  assert.equal(environment.downloads.length, 1);
  const imageTurn = environment.calls[0]!;
  const imageArtifacts = imageTurn.artifacts ?? [];
  assert.equal(imageArtifacts.length, 1);
  assert.equal(imageArtifacts[0]!.mediaKind, "image");
  assert.equal(imageArtifacts[0]!.mimeType, "image/png");

  environment.setDownloadData(encryptMedia(Buffer.from("plain file bytes")));
  environment.setDownloadFilename("story.txt");
  socket.push(
    callback("m-11", "", {
      msgtype: "file",
      file: { url: "https://example.test/file", aeskey: MEDIA_AESKEY },
    }),
  );
  await waitFor(() => environment.calls.length === 2, "file turn");
  assert.equal((environment.calls[1]!.artifacts ?? [])[0]!.mediaKind, "file");
  assert.equal(
    (environment.calls[1]!.artifacts ?? [])[0]!.displayName,
    "story.txt",
  );

  socket.push(
    callback("m-12", "", {
      msgtype: "video",
      video: { url: "https://example.test/video", aeskey: MEDIA_AESKEY },
    }),
  );
  await waitFor(() => environment.calls.length === 3, "video turn");
  assert.equal((environment.calls[2]!.artifacts ?? [])[0]!.mediaKind, "file");
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom stages media in text-trigger mode until a text arrives", async () => {
  const environment = setup({ mediaMode: "text-trigger" });
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.push(
    callback("m-20", "", {
      msgtype: "image",
      image: { url: "https://example.test/staged", aeskey: MEDIA_AESKEY },
    }),
  );
  await waitFor(() => environment.downloads.length === 1, "download");
  await wait(100);
  assert.equal(environment.calls.length, 0, "staged media does not trigger");
  socket.push(callback("m-21", "看看这张图"));
  await waitFor(() => environment.calls.length === 1, "trigger turn");
  assert.equal(environment.calls[0]!.prompt, "看看这张图");
  assert.equal((environment.calls[0]!.artifacts ?? []).length, 1);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom converts voice callbacks to text prompts", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.push(
    callback("m-30", "", {
      msgtype: "voice",
      voice: { content: "语音转文字内容" },
    }),
  );
  await waitFor(() => environment.calls.length === 1, "voice turn");
  assert.equal(environment.calls[0]!.prompt, "语音转文字内容");
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom reports media failures without admitting a Turn", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  environment.setDownloadData(Buffer.from("not encrypted at all"));
  socket.push(
    callback("m-40", "", {
      msgtype: "image",
      image: { url: "https://example.test/bad", aeskey: MEDIA_AESKEY },
    }),
  );
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 1,
    "media failure reply",
  );
  const sent = socket.sentCmd("aibot_send_msg")[0] as {
    body: { markdown: { content: string } };
  };
  assert.match(sent.body.markdown.content, /media-invalid/);
  assert.equal(environment.calls.length, 0);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom delivers artifact outbox rows through media upload", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.ackBodies = {
    aibot_upload_media_init: { upload_id: "upload-1" },
    aibot_upload_media_finish: {
      type: "file",
      media_id: "media-1",
      created_at: "0",
    },
  };
  const fileBytes = Buffer.from("hitch wecom artifact payload");
  const artifact = await environment.media.ingest(
    "alice",
    (async function* () {
      yield fileBytes;
    })(),
    { displayName: "hello.txt", advertisedMime: "text/plain" },
  );
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      artifact.id,
      artifact.userId,
      artifact.storageKey,
      artifact.sha256,
      artifact.bytes,
      artifact.mediaKind,
      artifact.mimeType,
      artifact.displayName,
      now,
    );
  environment.foundation.database.connection
    .prepare(
      `INSERT INTO outbox(
         id, user_id, endpoint_id, turn_id, artifact_id, kind, payload_text,
         state, attempts, created_at, updated_at
       ) VALUES ('outbox-media', 'alice', ?, NULL, ?, 'artifact', NULL, 'pending', 0, ?, ?)`,
    )
    .run(endpoint!.id, artifact.id, now, now);
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 1,
    "media send",
  );
  const init = socket.sentCmd("aibot_upload_media_init")[0] as {
    body: {
      type: string;
      filename: string;
      total_size: number;
      total_chunks: number;
      md5: string;
    };
  };
  assert.deepEqual(
    [
      init.body.type,
      init.body.filename,
      init.body.total_size,
      init.body.total_chunks,
    ],
    ["file", "hello.txt", fileBytes.length, 1],
  );
  assert.match(init.body.md5, /^[0-9a-f]{32}$/);
  const chunk = socket.sentCmd("aibot_upload_media_chunk")[0] as {
    body: { upload_id: string; chunk_index: number; base64_data: string };
  };
  assert.equal(chunk.body.upload_id, "upload-1");
  assert.equal(chunk.body.chunk_index, 0);
  assert.equal(
    Buffer.from(chunk.body.base64_data, "base64").compare(fileBytes),
    0,
  );
  assert.equal(socket.sentCmd("aibot_upload_media_finish").length, 1);
  const sent = socket.sentCmd("aibot_send_msg")[0] as {
    body: { msgtype: string; file: { media_id: string } };
  };
  assert.deepEqual(
    [sent.body.msgtype, sent.body.file.media_id],
    ["file", "media-1"],
  );
  await waitFor(
    () => outboxState(environment, "outbox-media") === "sent",
    "artifact outbox sent",
  );
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

test("WeCom fails artifact outbox rows when the object is missing", async () => {
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

test("WeCom keeps the connection when heartbeat acks flow but pongs never arrive", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  // The production server ignores RFC6455 pings; heartbeat acks alone must
  // keep the connection alive.
  socket.autoPong = false;
  await wait(200);
  assert.equal(environment.sockets.length, 1);
  assert.ok(socket.pingCount > 0, "pings were sent");
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom treats stale liveness (no pong, no ack) as a dead connection", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  await waitFor(() => socket.pingCount > 0, "protocol pings running");
  socket.autoPong = false;
  socket.autoAck = false;
  await waitFor(() => environment.sockets.length === 2, "liveness reconnect");
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom ignores malformed frames and server-initiated heartbeats", async () => {
  const environment = setup();
  const { controller, done } = await startWorker(environment);
  const socket = environment.sockets[0]!;
  socket.pushRaw("this is not json{");
  socket.push({ cmd: "ping", headers: { req_id: "ping_1" } });
  socket.push({ headers: {} });
  await wait(100);
  assert.equal(environment.sockets.length, 1);
  assert.equal(environment.calls.length, 0);
  controller.abort();
  await done;
  environment.foundation.close();
});

test("WeCom parses Content-Disposition filenames safely", () => {
  assert.equal(
    parseWeComDispositionFilename('attachment; filename="report.txt"'),
    "report.txt",
  );
  assert.equal(
    parseWeComDispositionFilename(
      "attachment; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.txt",
    ),
    "报表.txt",
  );
  assert.equal(parseWeComDispositionFilename(null), undefined);
  assert.equal(parseWeComDispositionFilename("attachment"), undefined);
  assert.equal(
    parseWeComDispositionFilename('attachment; filename="../evil.txt"'),
    undefined,
  );
  assert.equal(
    parseWeComDispositionFilename("attachment; filename*=UTF-8''%zz"),
    undefined,
  );
  assert.equal(
    parseWeComDispositionFilename(`attachment; filename="${"a".repeat(200)}"`),
    undefined,
  );
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

test("expired staged WeCom attachments produce a notice before the Turn reply", async () => {
  const environment = setup({ mediaMode: "text-trigger" });
  const controller = new AbortController();
  const done = environment.worker.run(controller.signal);
  const socket = environment.sockets[0]!;
  await waitFor(() => socket.sentCmd("aibot_subscribe").length === 1, "sub");
  socket.push(
    callback("m-30", "", {
      msgtype: "file",
      file: { url: "https://example.test/file", aeskey: MEDIA_AESKEY },
    }),
  );
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 1,
    "staging ack",
  );
  environment.advanceClock(11 * 60 * 1000);
  socket.push(callback("m-31", "hi"));
  await waitFor(() => environment.calls.length === 1, "trigger turn");
  assert.equal(
    (environment.calls[0]!.artifacts ?? []).length,
    0,
    "expired staged artifacts must not reach the Turn",
  );
  await waitFor(
    () => socket.sentCmd("aibot_send_msg").length === 3,
    "notice plus reply",
  );
  const notice = JSON.stringify(socket.sentCmd("aibot_send_msg")[1]);
  assert.ok(notice.includes("expired after 10 minutes"), notice);
  controller.abort();
  await done;
  environment.foundation.close();
});
