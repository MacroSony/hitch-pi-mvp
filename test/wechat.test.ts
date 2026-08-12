import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GetUpdatesResp } from "wechat-ilink-client";

import { HitchApplication } from "../src/app/application.js";
import { AppError } from "../src/app/errors.js";
import { HitchStore } from "../src/app/store.js";
import {
  classifyWeChatIdentity,
  readWeChatMediaDescriptors,
} from "../src/channels/wechat-ingress.js";
import {
  WeChatError,
  WeChatIlinkClient,
  WeChatWorker,
  type WeChatRawClient,
} from "../src/channels/wechat.js";
import {
  WeChatStateStore,
  writeWeChatCredentials,
} from "../src/channels/wechat-state.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { MediaStore } from "../src/media/media-store.js";
import {
  FakeAgentRuntime,
  type RuntimeArtifact,
  type RuntimeTurn,
} from "../src/runtime/runtime.js";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function message(
  messageId: number,
  peerId: string,
  items: readonly unknown[],
  contextToken = `context-${messageId}`,
): Record<string, unknown> {
  return {
    message_type: 1,
    message_state: 2,
    message_id: messageId,
    from_user_id: peerId,
    to_user_id: "bot-account",
    group_id: "",
    context_token: contextToken,
    item_list: items,
  };
}

function textItem(text: string): Record<string, unknown> {
  return { type: 1, text_item: { text } };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hitch-wechat-test-"));
  chmodSync(root, 0o700);
  const paths = {
    data: join(root, "data"),
    pi: join(root, "pi"),
    state: join(root, "wechat"),
    alice: join(root, "alice"),
    bob: join(root, "bob"),
  };
  for (const path of [paths.pi, paths.state, paths.alice, paths.bob])
    privateDirectory(path);
  writeWeChatCredentials(paths.state, {
    schemaVersion: 1,
    authenticatedAccountId: "bot-account",
    token: "private-token",
    baseUrl: "https://api.example.test",
    cdnBaseUrl: "https://cdn.example.test/c2c",
  });
  const foundation = bootstrapFoundation(
    parseConfig({
      schemaVersion: 1,
      dataRoot: paths.data,
      piProfileDir: paths.pi,
      minimumFreeBytes: 0,
      telegramAccounts: [],
      wechatAccounts: [{ id: "primary", stateDir: paths.state }],
      users: [
        {
          id: "alice",
          workspace: paths.alice,
          wechat: { account: "primary", userId: "wx-alice" },
        },
        {
          id: "bob",
          workspace: paths.bob,
          wechat: { account: "primary", userId: "wx-bob" },
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
  const state = new WeChatStateStore("primary", paths.state);
  return { foundation, media, paths, state, store };
}

class FixtureClient implements WeChatRawClient {
  public response: GetUpdatesResp = {
    ret: 0,
    msgs: [],
    get_updates_buf: "cursor-1",
  };
  public downloads = 0;
  public readonly texts: Array<{
    peerId: string;
    text: string;
    contextToken: string;
  }> = [];
  public readonly artifacts: RuntimeArtifact[] = [];
  public failText = false;

  public async getUpdates(): Promise<GetUpdatesResp> {
    return this.response;
  }

  public async *download(): AsyncGenerator<Uint8Array> {
    this.downloads += 1;
    yield Buffer.from("file");
  }

  public async sendText(
    peerId: string,
    text: string,
    contextToken: string,
  ): Promise<void> {
    if (this.failText) throw new WeChatError("fixture delivery failed");
    this.texts.push({ peerId, text, contextToken });
  }

  public async sendArtifact(
    _peerId: string,
    artifact: RuntimeArtifact,
  ): Promise<void> {
    this.artifacts.push(artifact);
  }
}

test("WeChat identity rejects groups and unstable IDs before item access", () => {
  let contentReads = 0;
  const group = message(1, "wx-alice", []);
  group.group_id = "group-1";
  Object.defineProperty(group, "item_list", {
    get: () => {
      contentReads += 1;
      throw new Error("content was accessed");
    },
  });
  assert.throws(
    () => classifyWeChatIdentity("bot-account", group),
    (error: unknown) =>
      error instanceof AppError && error.category === "rejected",
  );
  assert.equal(contentReads, 0);
  assert.throws(
    () =>
      classifyWeChatIdentity("bot-account", {
        ...message(2, "wx-alice", [textItem("hello")]),
        message_id: "2",
      }),
    (error: unknown) => error instanceof AppError,
  );
  assert.throws(
    () =>
      classifyWeChatIdentity("bot-account", {
        ...message(3, "wx-alice", [textItem("hello")]),
        to_user_id: "different-bot",
      }),
    (error: unknown) => error instanceof AppError,
  );
  const imageIdentity = classifyWeChatIdentity(
    "bot-account",
    message(4, "wx-alice", [
      { type: 2, image_item: { mid_size: 16 } },
      { type: 5, video_item: { video_size: 32 } },
    ]),
  );
  assert.deepEqual(
    readWeChatMediaDescriptors(imageIdentity).map(
      ({ transportBytes }) => transportBytes,
    ),
    [16, 32],
  );
});

test("WeChat state binds opaque reply context to the local account and peer", () => {
  const environment = setup();
  environment.state.commit("durable-cursor", [["wx-alice", "opaque-token"]]);
  assert.equal(environment.state.context("wx-alice"), "opaque-token");
  assert.equal(environment.state.context("wx-bob"), undefined);
  const differentAccount = new WeChatStateStore(
    "secondary",
    environment.paths.state,
  );
  assert.equal(differentAccount.cursor(), "durable-cursor");
  assert.equal(differentAccount.context("wx-alice"), undefined);
  environment.foundation.close();
});

test("WeChat worker admits exact peers, commits cursor/context, and does not rerun duplicates", async () => {
  const environment = setup();
  const turns: RuntimeTurn[] = [];
  const app = new HitchApplication(
    environment.store,
    new FakeAgentRuntime((turn) => {
      turns.push(turn);
      return {
        outcome: "succeeded",
        text: `reply:${turn.prompt}`,
        sessionReusable: true,
      };
    }),
  );
  app.start();
  const client = new FixtureClient();
  const hiddenItems = message(10, "wx-unknown", []);
  Object.defineProperty(hiddenItems, "item_list", {
    get: () => {
      throw new Error("unknown peer content was accessed");
    },
  });
  client.response = {
    ret: 0,
    get_updates_buf: "cursor-after-admission",
    msgs: [
      hiddenItems,
      message(11, "wx-alice", [textItem("hello from WeChat")], "ctx-a"),
    ],
  };
  const worker = new WeChatWorker(
    "primary",
    client,
    environment.state,
    app,
    environment.store,
    environment.media,
  );
  assert.equal(await worker.pollOnce(), 2);
  await app.drain();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.userId, "alice");
  assert.equal(environment.state.cursor(), "cursor-after-admission");
  assert.equal(environment.state.context("wx-alice"), "ctx-a");
  assert.deepEqual(client.texts, [
    {
      peerId: "wx-alice",
      text: "reply:hello from WeChat",
      contextToken: "ctx-a",
    },
  ]);
  assert.equal(client.downloads, 0);

  client.response = {
    ret: 0,
    get_updates_buf: "cursor-after-duplicate",
    msgs: [message(11, "wx-alice", [textItem("hello from WeChat")], "ctx-b")],
  };
  await worker.pollOnce();
  await app.drain();
  assert.equal(turns.length, 1);
  assert.equal(environment.state.context("wx-alice"), "ctx-b");
  environment.foundation.close();
});

test("WeChat media reuses owner-scoped ingestion and artifact delivery", async () => {
  const environment = setup();
  const publicationSource = join(
    environment.paths.alice,
    "0123456789abcdef0123456789abcdef.blob",
  );
  writeFileSync(publicationSource, "outbound", { mode: 0o600 });
  const app = new HitchApplication(
    environment.store,
    new FakeAgentRuntime((turn) => ({
      outcome: "succeeded",
      text: "media complete",
      sessionReusable: true,
      artifacts: [
        environment.media.promotePublished(
          turn.userId,
          publicationSource,
          "answer.txt",
        ),
      ],
    })),
  );
  app.start();
  const client = new FixtureClient();
  client.response = {
    ret: 0,
    get_updates_buf: "media-cursor",
    msgs: [
      message(20, "wx-alice", [
        textItem("inspect this"),
        {
          type: 4,
          file_item: {
            file_name: "note.txt",
            len: "4",
            media: {
              encrypt_query_param: "opaque",
              aes_key: Buffer.alloc(16).toString("base64"),
            },
          },
        },
      ]),
    ],
  };
  const worker = new WeChatWorker(
    "primary",
    client,
    environment.state,
    app,
    environment.store,
    environment.media,
  );
  await worker.pollOnce();
  await app.drain();
  await worker.deliverOnce();
  assert.equal(client.downloads, 1);
  assert.equal(client.artifacts.length, 1);
  assert.equal(client.artifacts[0]?.userId, "alice");
  assert.equal(client.artifacts[0]?.displayName, "answer.txt");
  environment.foundation.close();
});

test("WeChat advances its cursor before a best-effort rejection reply", async () => {
  const environment = setup();
  const app = new HitchApplication(
    environment.store,
    new FakeAgentRuntime(() => {
      throw new Error("invalid media must not run");
    }),
  );
  app.start();
  const client = new FixtureClient();
  client.failText = true;
  client.response = {
    ret: 0,
    get_updates_buf: "rejected-cursor",
    msgs: [
      message(30, "wx-alice", [
        {
          type: 4,
          file_item: { file_name: "broken.txt", len: "not-a-number" },
        },
      ]),
    ],
  };
  const worker = new WeChatWorker(
    "primary",
    client,
    environment.state,
    app,
    environment.store,
    environment.media,
  );
  await assert.rejects(worker.pollOnce(), WeChatError);
  assert.equal(environment.state.cursor(), "rejected-cursor");
  assert.equal(environment.state.context("wx-alice"), "context-30");
  assert.equal(environment.store.count("turns", "alice"), 0);
  environment.foundation.close();
});

test("WeChat rejects a nonempty batch without a nonempty next cursor", async () => {
  const environment = setup();
  const app = new HitchApplication(environment.store, new FakeAgentRuntime());
  app.start();
  const client = new FixtureClient();
  client.response = {
    ret: 0,
    get_updates_buf: "",
    msgs: [message(31, "wx-alice", [textItem("must not admit")])],
  };
  const worker = new WeChatWorker(
    "primary",
    client,
    environment.state,
    app,
    environment.store,
    environment.media,
  );
  await assert.rejects(worker.pollOnce(), WeChatError);
  assert.equal(environment.store.count("turns", "alice"), 0);
  environment.foundation.close();
});

test("raw WeChat client streams bounded AES media decryption", async () => {
  const plaintext = Buffer.from("four");
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  let requested = "";
  const client = new WeChatIlinkClient(
    {
      schemaVersion: 1,
      authenticatedAccountId: "bot-account",
      token: "private-token",
      baseUrl: "https://api.example.test",
      cdnBaseUrl: "https://cdn.example.test/c2c",
    },
    async (input) => {
      requested = String(input);
      return new Response(encrypted, {
        headers: { "content-length": String(encrypted.length) },
      });
    },
  );
  const identity = classifyWeChatIdentity(
    "bot-account",
    message(40, "wx-alice", [
      {
        type: 4,
        file_item: {
          file_name: "plain.txt",
          len: "4",
          media: {
            encrypt_query_param: "opaque query",
            aes_key: key.toString("base64"),
          },
        },
      },
    ]),
  );
  const descriptor = readWeChatMediaDescriptors(identity)[0];
  assert.ok(descriptor !== undefined);
  const chunks: Buffer[] = [];
  for await (const chunk of client.download(descriptor))
    chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "four");
  assert.equal(
    requested,
    "https://cdn.example.test/c2c/download?encrypted_query_param=opaque%20query",
  );
});

test("raw WeChat delivery supports current upload URLs and rejects ret failures", async () => {
  const environment = setup();
  const artifact = await environment.media.ingest(
    "alice",
    (async function* () {
      yield Buffer.from("file");
    })(),
    {
      advertisedBytes: 4,
      advertisedMime: "text/plain",
      displayName: "note.txt",
    },
  );
  const requests: Array<{ url: string; body: unknown }> = [];
  const api = {
    getUpdates: async () => ({ ret: 0, msgs: [], get_updates_buf: "" }),
    getUploadUrl: async () => ({
      ret: 0,
      upload_param: "",
      upload_full_url: "https://upload.example.test/current-shape",
    }),
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body });
    if (url.startsWith("https://upload.example.test/")) {
      return new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "download-parameter" },
      });
    }
    return new Response('{"ret":0}', {
      headers: { "content-type": "application/json" },
    });
  };
  const credentials = environment.state.credentials;
  const client = new WeChatIlinkClient(credentials, fetcher, api);
  await client.sendArtifact("wx-alice", artifact, environment.media, "context");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://upload.example.test/current-shape");
  assert.equal(
    requests[1]?.url,
    "https://api.example.test/ilink/bot/sendmessage",
  );
  const sendBody = JSON.parse(String(requests[1]?.body)) as {
    msg: { to_user_id: string; context_token: string };
  };
  assert.equal(sendBody.msg.to_user_id, "wx-alice");
  assert.equal(sendBody.msg.context_token, "context");

  const rejected = new WeChatIlinkClient(
    credentials,
    async () => new Response('{"ret":-2}'),
    api,
  );
  await assert.rejects(
    rejected.sendText("wx-alice", "hello", "context"),
    WeChatError,
  );
  environment.media.discard(artifact);
  environment.foundation.close();
});
