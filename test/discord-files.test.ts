import { createServer } from "node:http";
// Intentionally load root Undici before discord.js's nested REST dependency.
import { Response as UndiciResponse } from "undici";
import assert from "node:assert/strict";
import { Client } from "discord.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HitchApplication } from "../src/app/application.js";
import { HitchStore, type IdSource } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import {
  FakeAgentRuntime,
  type RuntimeTurn,
  type RuntimeArtifact,
} from "../src/runtime/runtime.js";
import {
  MediaStore,
  MAX_INPUT_ARTIFACT_BYTES,
} from "../src/media/media-store.js";
import {
  DiscordJsClient,
  discordRestMakeRequest,
  DiscordTransportError,
  discordFailureDiagnostic,
  DiscordWorker,
  DISCORD_UPLOAD_LIMIT_BYTES,
  type DiscordClient,
  type DiscordMessage,
} from "../src/channels/discord.js";
import type { DiscordAttachment } from "../src/channels/discord-ingress.js";

class Sequence implements IdSource {
  #n = 0;
  next(kind: "session" | "pi" | "turn" | "outbox"): string {
    this.#n += 1;
    return kind === "pi" ? `pi-${this.#n}` : `${kind}-${this.#n}`;
  }
}

function discordMessage(
  id: string,
  channelId: string,
  authorId: string,
  content: string,
  options: {
    guildId?: string;
    mentionsBot?: boolean;
    referencedAuthorId?: string;
    replyToMessageId?: string;
    hasAttachments?: boolean;
  } = {},
) {
  return {
    id,
    channelId,
    guildId: options.guildId ?? null,
    channelType: options.guildId === undefined ? "dm" : "guild-text",
    author: { id: authorId, name: authorId, bot: false },
    content,
    mentionsBot: options.mentionsBot ?? options.guildId !== undefined,
    ...(options.referencedAuthorId === undefined
      ? {}
      : { referencedAuthorId: options.referencedAuthorId }),
    ...(options.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: options.replyToMessageId }),
    timestamp: "2026-10-01T00:00:00.000Z",
    hasAttachments: options.hasAttachments ?? false,
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hitch-discord-app-"));
  const directory = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  };
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot: directory("data"),
    piProfileDir: directory("pi"),
    minimumFreeBytes: 0,
    telegramAccounts: [],
    wechatAccounts: [],
    wecomAccounts: [],
    discordAccounts: [{ id: "bot", botTokenEnv: "HITCH_DISCORD_TEST_TOKEN" }],
    users: [
      {
        id: "server-owner",
        workspace: directory("server"),
        discord: {
          mode: "server",
          account: "bot",
          guildId: "10000000000000001",
          channelIds: ["10000000000000011", "10000000000000012"],
          adminUserIds: ["30000000000000001"],
        },
      },
      {
        id: "dm-owner-a",
        workspace: directory("dm-a"),
        discord: {
          mode: "dm",
          account: "bot",
          userId: "20000000000000001",
          channelId: "20000000000000021",
        },
      },
      {
        id: "dm-owner-b",
        workspace: directory("dm-b"),
        discord: {
          mode: "dm",
          account: "bot",
          userId: "20000000000000002",
          channelId: "20000000000000022",
        },
      },
    ],
  });
  const foundation = bootstrapFoundation(config);
  const ids = new Sequence();
  const store = new HitchStore(foundation.database, ids);
  return { foundation, store, config, ids };
}

const dm = (id: string, text = "", files = true): DiscordMessage => ({
  ...discordMessage(id, "20000000000000021", "20000000000000001", text),
  channelType: "dm",
  hasAttachments: files,
  ...(files
    ? {
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/test",
            name: "hello.txt",
            size: 5,
            contentType: "text/plain",
          },
        ],
      }
    : {}),
});
const server = (id: string, text = "<@bot-user>"): DiscordMessage => ({
  ...dm(id, text),
  channelType: "guild-text",
  guildId: "10000000000000001",
  channelId: "10000000000000011",
  mentionsBot: true,
});
class FileClient implements DiscordClient {
  readonly botUserId = "bot-user";
  downloads = 0;
  uploads: Array<{ channel: string; artifact: RuntimeArtifact }> = [];
  texts: string[] = [];
  uploadFailure = false;
  cancelUpload: AbortController | undefined;
  messages: DiscordMessage[] = [];
  abort: AbortController | undefined;
  assertHealthy(): void {}
  async connect(callback: (message: DiscordMessage) => void): Promise<void> {
    this.messages.forEach(callback);
    setTimeout(() => this.abort?.abort(), 100);
  }
  async close(): Promise<void> {}
  async fetchReferencedAuthor(): Promise<string> {
    return this.botUserId;
  }
  async sendTyping(): Promise<void> {}
  async sendText(_channel: string, text: string): Promise<void> {
    this.texts.push(text);
  }
  async downloadAttachment(
    _file: DiscordAttachment,
  ): Promise<AsyncIterable<Uint8Array>> {
    this.downloads++;
    return (async function* () {
      yield Buffer.from("hello");
    })();
  }
  async sendArtifact(
    channel: string,
    artifact: RuntimeArtifact,
    media: MediaStore,
  ): Promise<void> {
    assert.equal(
      readFileSync(media.verifiedObjectPath(artifact)).length,
      artifact.bytes,
    );
    if (this.uploadFailure) throw new Error("raw SDK secret fixture");
    this.uploads.push({ channel, artifact });
    this.cancelUpload?.abort();
  }
}
function fixture(mode: "text-trigger" | "always-trigger" = "text-trigger") {
  const environment = setup();
  const media = new MediaStore(environment.config.dataRoot, 0);
  const turns: RuntimeTurn[] = [];
  let output: readonly RuntimeArtifact[] = [];
  const app = new HitchApplication(
    environment.store,
    new FakeAgentRuntime((turn) => {
      turns.push(turn);
      return {
        outcome: "succeeded",
        text: "done",
        sessionReusable: true,
        artifacts: output,
      };
    }),
    mode,
    media,
    undefined,
    undefined,
    undefined,
    [],
    30000,
    1800000,
    environment.config.users,
  );
  app.start();
  const client = new FileClient();
  const logs: string[] = [];
  const worker = new DiscordWorker({ id: "bot" }, app, environment.store, {
    client,
    media,
    logger: (message) => logs.push(message),
  });
  return {
    ...environment,
    media,
    app,
    client,
    worker,
    logs,
    turns,
    output: (files: readonly RuntimeArtifact[]) => {
      output = files;
    },
  };
}
async function receive(
  f: ReturnType<typeof fixture>,
  messages: DiscordMessage[],
) {
  const abort = new AbortController();
  f.client.messages = messages;
  f.client.abort = abort;
  await f.worker.run(abort.signal);
  await f.app.drain();
}
async function object(
  f: ReturnType<typeof fixture>,
  data: Buffer,
  name = "report.txt",
) {
  return f.media.ingest(
    "dm-owner-a",
    (async function* () {
      yield data;
    })(),
    { displayName: name },
  );
}
for (const [label, message, owner] of [
  ["DM", dm("stage-dm"), "dm-owner-a"],
  ["server mention", server("stage-server"), "server-owner"],
] as const) {
  test(`Discord ${label} attachment-only stages in existing pipeline and deduplicates`, async () => {
    const f = fixture();
    try {
      await receive(f, [message, message]);
      assert.equal(f.store.stagedArtifactCount(owner), 1);
      assert.equal(f.store.count("artifacts", owner), 1);
      assert.equal(f.turns.length, 0);
      assert.equal(f.store.count("turns", owner), 1);
      const prompt = {
        ...message,
        id: "use-file",
        content: "inspect this",
        hasAttachments: false,
        attachments: [],
      };
      assert.equal(
        f.app.receiveDiscord("bot", "bot-user", prompt).accepted,
        true,
      );
      await f.app.drain();
      assert.equal(f.turns[0]?.artifacts?.[0]?.userId, owner);
      assert.equal(f.store.stagedArtifactCount(owner), 0);
    } finally {
      f.foundation.close();
    }
  });
}
for (const [label, message] of [
  ["non-trigger", { ...server("quiet", "hello"), mentionsBot: false }],
  ["denied channel", { ...server("denied"), channelId: "not-allowed" }],
  [
    "bot",
    { ...server("bot"), author: { id: "other", name: "Bot", bot: true } },
  ],
  ["webhook", { ...server("hook"), webhookId: "hook" }],
] as const) {
  test(`Discord ${label} attachment is never downloaded`, async () => {
    const f = fixture();
    try {
      await receive(f, [message]);
      assert.equal(f.client.downloads, 0);
      assert.equal(f.store.count("artifacts"), 0);
    } finally {
      f.foundation.close();
    }
  });
}
test("Discord inbound over-limit uses media-invalid and avoids download", async () => {
  const f = fixture();
  try {
    const message = dm("large");
    await receive(f, [
      {
        ...message,
        attachments: [
          { ...message.attachments![0]!, size: MAX_INPUT_ARTIFACT_BYTES + 1 },
        ],
      },
    ]);
    assert.equal(f.client.downloads, 0);
    assert.equal(f.store.count("artifacts"), 0);
    assert.match(f.client.texts.join("\n"), /media-invalid.*20 MiB/);
  } finally {
    f.foundation.close();
  }
});
test("Discord always-trigger attachment-only reaches Pi and materializes via existing inbox", async () => {
  const f = fixture("always-trigger");
  try {
    await receive(f, [dm("inspect")]);
    assert.match(f.turns[0]!.prompt, /Please inspect the attached media/);
    const artifact = f.turns[0]!.artifacts![0]!;
    const inbox = join(f.config.dataRoot, "inbox-test");
    mkdirSync(inbox);
    const path = f.media.materializeInbox(artifact, inbox, 0);
    assert.equal(
      readFileSync(join(inbox, path.slice("/inbox/".length)), "utf8"),
      "hello",
    );
  } finally {
    f.foundation.close();
  }
});
test("Discord later turn claims prior originals at their original inbox ordinal", async () => {
  const f = fixture("always-trigger");
  try {
    await receive(f, [dm("image-first")]);
    const original = f.turns[0]!.artifacts![0]!;
    f.client.messages = [dm("later", "use the earlier file", false)];
    const abort = new AbortController();
    f.client.abort = abort;
    await f.worker.run(abort.signal);
    await f.app.drain();
    const later = f.turns[1]!;
    assert.equal(later.historicalAttachments?.length, 1);
    assert.equal(later.historicalAttachments![0]!.originalOrdinal, 0);
    assert.equal(later.historicalAttachments![0]!.artifact.id, original.id);
    const inbox = join(f.config.dataRoot, "inbox-later");
    mkdirSync(inbox);
    const path = f.media.materializeInbox(
      original,
      inbox,
      Number(later.historicalAttachments![0]!.originalOrdinal),
    );
    assert.match(path, /\/1-.*\.txt$/u);
    assert.equal(
      readFileSync(join(inbox, path.slice("/inbox/".length)), "utf8"),
      "hello",
    );
  } finally {
    f.foundation.close();
  }
});
test("Discord staged server files share channels, never cross into DM owners", async () => {
  const f = fixture();
  try {
    await receive(f, [server("shared"), dm("private")]);
    assert.equal(
      f.app.receiveDiscord("bot", "bot-user", dm("dm-read", "use mine", false))
        .accepted,
      true,
    );
    assert.equal(
      f.app.receiveDiscord("bot", "bot-user", {
        ...server("server-read", "use shared"),
        channelId: "10000000000000012",
        hasAttachments: false,
        attachments: [],
      }).accepted,
      true,
    );
    await f.app.drain();
    assert.deepEqual(
      f.turns
        .find((t) => t.userId === "dm-owner-a")!
        .artifacts!.map((a) => a.userId),
      ["dm-owner-a"],
    );
    assert.deepEqual(
      f.turns
        .find((t) => t.userId === "server-owner")!
        .artifacts!.map((a) => a.userId),
      ["server-owner"],
    );
    const wrongOwner = await object(f, Buffer.from("private"));
    assert.equal(
      f.app.receiveDiscord("bot", "bot-user", server("cross-owner", "read"), [
        wrongOwner,
      ]).accepted,
      false,
    );
  } finally {
    f.foundation.close();
  }
});
test("Discord uploads outbound image and document to originating channel with durable sent states", async () => {
  const f = fixture();
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=",
      "base64",
    );
    f.output([
      await object(f, png, "image.png"),
      await object(f, Buffer.from("report")),
    ]);
    assert.equal(
      f.app.receiveDiscord("bot", "bot-user", dm("produce", "create", false))
        .accepted,
      true,
    );
    await f.app.drain();
    await f.worker.deliverPending();
    assert.deepEqual(
      f.client.uploads.map((u) => [u.channel, u.artifact.mediaKind]),
      [
        ["20000000000000021", "image"],
        ["20000000000000021", "file"],
      ],
    );
    assert.equal(f.store.pendingDiscordOutbox("bot").length, 0);
  } finally {
    f.foundation.close();
  }
});
test("Discord oversize failure and explanatory text are durable across reopen", async () => {
  const f = fixture();
  const large = await object(
    f,
    Buffer.alloc(DISCORD_UPLOAD_LIMIT_BYTES + 1, 65),
    "big.txt",
  );
  f.output([large]);
  f.app.receiveDiscord("bot", "bot-user", dm("big-output", "create", false));
  await f.app.drain();
  await f.worker.deliverPending();
  assert.equal(f.client.uploads.length, 0);
  const state = f.foundation.database.connection
    .prepare("SELECT state FROM outbox WHERE kind = 'artifact'")
    .get() as { state: string };
  assert.equal(state.state, "failed");
  f.foundation.close();
  const reopened = bootstrapFoundation(f.config);
  try {
    const store = new HitchStore(reopened.database, f.ids);
    const notice = store
      .pendingDiscordOutbox("bot")
      .find((d) => d.text?.includes("big.txt"));
    assert.ok(notice);
    assert.match(notice.text!, /10485761 bytes/);
    await new DiscordWorker({ id: "bot" }, f.app, store, {
      client: f.client,
      media: f.media,
    }).deliverPending();
    assert.match(f.client.texts.join("\n"), /too large.*10485761/);
    assert.equal(store.pendingDiscordOutbox("bot").length, 0);
  } finally {
    reopened.close();
  }
});
test("Discord worker logs only safe artifact diagnostics and retains retry", async () => {
  const f = fixture();
  try {
    f.output([await object(f, Buffer.from("diagnostic"))]);
    f.app.receiveDiscord("bot", "bot-user", dm("diagnostic", "create", false));
    await f.app.drain();
    const hostile = new Error("token=secret path=/private response=secret");
    Object.defineProperties(hostile, {
      status: { value: 403 },
      code: { value: 50013 },
      headers: { value: { authorization: "secret" } },
    });
    f.client.sendArtifact = async () => {
      throw DiscordTransportError.artifactFailure("upload", hostile);
    };
    await f.worker.deliverPending();
    assert.equal(f.store.pendingDiscordOutbox("bot").length, 1);
    assert.match(
      f.logs.join("\n"),
      /phase=upload kind=http status=403 code=50013/u,
    );
    assert.doesNotMatch(f.logs.join("\n"), /secret|private|authorization/u);
  } finally {
    f.foundation.close();
  }
});

test("Discord artifact transport errors and cancelled uploads retain retry semantics", async () => {
  const f = fixture();
  try {
    f.output([await object(f, Buffer.from("retry"))]);
    f.app.receiveDiscord("bot", "bot-user", dm("retry-file", "create", false));
    await f.app.drain();
    f.client.uploadFailure = true;
    await f.worker.deliverPending();
    assert.equal(
      f.store.pendingDiscordOutbox("bot").filter((d) => d.kind === "artifact")
        .length,
      1,
    );
    f.client.uploadFailure = false;
    f.client.cancelUpload = new AbortController();
    await f.worker.deliverPending(f.client.cancelUpload.signal);
    assert.equal(
      f.store.pendingDiscordOutbox("bot").filter((d) => d.kind === "artifact")
        .length,
      1,
    );
    await f.worker.deliverPending();
    assert.equal(f.store.pendingDiscordOutbox("bot").length, 0);
  } finally {
    f.foundation.close();
  }
});

test("Discord staging survives failed admission and duplicate text does not consume new files", async () => {
  const f = fixture();
  try {
    await receive(f, [dm("stage-before-busy")]);
    const file = await object(f, Buffer.from("later"));
    // Fill the existing one-active + three-queued owner capacity without yielding.
    for (let i = 0; i < 4; i++)
      assert.equal(
        f.app.receiveDiscord("bot", "bot-user", dm(`busy-${i}`, "work", false))
          .accepted,
        true,
      );
    // The first prompt consumed staging, so stage again before a rejected fifth prompt.
    assert.equal(
      f.app.receiveDiscord("bot", "bot-user", dm("stage-later"), [file])
        .accepted,
      true,
    );
    assert.equal(
      f.app.receiveDiscord("bot", "bot-user", dm("full", "work", false))
        .accepted,
      false,
    );
    assert.equal(f.store.stagedArtifactCount("dm-owner-a"), 1);
    assert.equal(
      f.app.receiveDiscord("bot", "bot-user", dm("busy-0", "work", false))
        .duplicate,
      true,
    );
    assert.equal(f.store.stagedArtifactCount("dm-owner-a"), 1);
    await f.app.drain();
  } finally {
    f.foundation.close();
  }
});

test("Pinned discord.js REST multipart upload works through an offline request fixture", async () => {
  const f = fixture();
  try {
    const artifact = await object(
      f,
      Buffer.from("multipart payload"),
      "payload.txt",
    );
    const requests: Array<{ method: string; path: string; form?: FormData }> =
      [];
    const sdkClient = new Client({
      intents: [],
      rest: {
        retries: 0,
        makeRequest: async (url, init) => {
          const parsed = new URL(url);
          const method = init.method ?? "GET";
          const form = init.body instanceof FormData ? init.body : undefined;
          requests.push({
            method,
            path: parsed.pathname,
            ...(form === undefined ? {} : { form }),
          });
          if (method === "GET")
            return new UndiciResponse(
              JSON.stringify({
                id: "123456789012345678",
                type: 1,
                recipients: [
                  {
                    id: "223456789012345678",
                    username: "fixture",
                    discriminator: "0",
                    avatar: null,
                  },
                ],
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          return new UndiciResponse(
            JSON.stringify({
              id: "323456789012345678",
              channel_id: "123456789012345678",
              type: 0,
              content: "",
              author: {
                id: "bot",
                username: "fixture",
                discriminator: "0",
                avatar: null,
                global_name: null,
                bot: true,
              },
              attachments: [],
              embeds: [],
              timestamp: new Date().toISOString(),
              edited_timestamp: null,
              flags: 0,
              components: [],
              mention_everyone: false,
              mentions: [],
              pinned: false,
              tts: false,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    });
    sdkClient.rest.setToken("offline-fixture-token");
    const sdk = new DiscordJsClient("offline-fixture-token", false, sdkClient);
    await sdk.sendArtifact("123456789012345678", artifact, f.media);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "POST"],
    );
    const upload = requests[1]!;
    assert.match(upload.path, /\/channels\/123456789012345678\/messages$/u);
    assert.ok(upload.form, "discord.js REST must construct multipart FormData");
    const fields = [...upload.form.entries()];
    const uploaded = fields.find(([name]) => name === "files[0]")?.[1];
    assert.ok(uploaded instanceof Blob);
    assert.equal((uploaded as File).name, "payload.txt");
    assert.deepEqual(
      Buffer.from(await uploaded.arrayBuffer()),
      Buffer.from("multipart payload"),
    );
    const payload = fields.find(([name]) => name === "payload_json")?.[1];
    assert.ok(typeof payload === "string");
    const json = JSON.parse(payload) as Record<string, unknown>;
    assert.deepEqual(json.allowed_mentions, {
      parse: [],
      replied_user: false,
    });
    assert.deepEqual(json.attachments, [{ id: "0" }]);
    assert.equal(json.tts, false);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      sdk.sendArtifact(
        "123456789012345678",
        artifact,
        f.media,
        {},
        aborted.signal,
      ),
      (error: unknown) => {
        assert.deepEqual(discordFailureDiagnostic(error), {
          phase: "artifact-size",
          kind: "aborted",
        });
        return true;
      },
    );
    await sdk.close();
  } finally {
    f.foundation.close();
  }
});

test("Discord REST captured fetch sends real multipart over loopback after global fetch replacement", async () => {
  const f = fixture();
  const requests: Array<{
    method: string;
    path: string;
    headers: import("node:http").IncomingHttpHeaders;
    body: Buffer;
  }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: request.method ?? "GET",
        path: request.url ?? "",
        headers: request.headers,
        body,
      });
      const value =
        request.method === "GET"
          ? {
              id: "123456789012345678",
              type: 1,
              recipients: [
                {
                  id: "223456789012345678",
                  username: "fixture",
                  discriminator: "0",
                  avatar: null,
                },
              ],
            }
          : {
              id: "323456789012345678",
              channel_id: "123456789012345678",
              type: 0,
              content: "",
              author: {
                id: "423456789012345678",
                username: "fixture",
                discriminator: "0",
                avatar: null,
                global_name: null,
                bot: true,
              },
              attachments: [],
              embeds: [],
              timestamp: new Date().toISOString(),
              edited_timestamp: null,
              flags: 0,
              components: [],
              mention_everyone: false,
              mentions: [],
              pinned: false,
              tts: false,
            };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const originalFetch = globalThis.fetch;
  let sdk: DiscordJsClient | undefined;
  try {
    const artifact = await object(
      f,
      Buffer.from("multipart payload"),
      "payload.txt",
    );
    globalThis.fetch = (async () => {
      throw new Error("replacement fetch must not be used by Discord REST");
    }) as typeof fetch;
    const client = new Client({
      intents: [],
      rest: {
        api: `http://127.0.0.1:${address.port}`,
        retries: 0,
        makeRequest: discordRestMakeRequest,
      },
    });
    client.rest.setToken("loopback-fixture-token");
    sdk = new DiscordJsClient("loopback-fixture-token", false, client);
    await sdk.sendArtifact("123456789012345678", artifact, f.media);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET", "POST"],
    );
    const upload = requests[1]!;
    assert.match(
      upload.path,
      /\/v10\/channels\/123456789012345678\/messages$/u,
    );
    const contentType = upload.headers["content-type"];
    assert.match(contentType ?? "", /^multipart\/form-data; boundary=/u);
    const boundary = /boundary=(.+)$/u.exec(contentType ?? "")?.[1];
    assert.ok(boundary);
    assert.ok(upload.body.includes(Buffer.from(`--${boundary}`)));
    assert.ok(upload.body.includes(Buffer.from('name="payload_json"')));
    assert.ok(
      upload.body.includes(
        Buffer.from('"allowed_mentions":{"parse":[],"replied_user":false}'),
      ),
    );
    assert.ok(
      upload.body.includes(
        Buffer.from('name="files[0]"; filename="payload.txt"'),
      ),
    );
    assert.ok(upload.body.includes(Buffer.from("multipart payload")));
    assert.ok(upload.body.includes(Buffer.from(`--${boundary}--`)));
  } finally {
    globalThis.fetch = originalFetch;
    await sdk?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    f.foundation.close();
  }
});

test("captured Discord REST fetch preserves HTTP status, body, and abort behavior", async () => {
  let signalRequestSeen!: () => void;
  const seen = new Promise<void>((resolve) => (signalRequestSeen = resolve));
  const server = createServer((request, response) => {
    if (request.url === "/status") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "fixture denied", code: 50013 }));
      return;
    }
    signalRequestSeen();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const denied = await discordRestMakeRequest(
      `http://127.0.0.1:${address.port}/status`,
      { method: "GET" },
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      message: "fixture denied",
      code: 50013,
    });

    const controller = new AbortController();
    const pending = discordRestMakeRequest(
      `http://127.0.0.1:${address.port}/stall`,
      { method: "GET", signal: controller.signal },
    );
    await seen;
    controller.abort();
    await assert.rejects(pending);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Discord stream size mismatch rejects and leaves no referenced media", async () => {
  const f = fixture();
  try {
    f.client.downloadAttachment = async () =>
      (async function* () {
        yield Buffer.from("too many bytes");
      })();
    await receive(f, [dm("mismatch")]);
    assert.equal(f.store.count("artifacts"), 0);
    assert.match(f.client.texts.join("\n"), /media-invalid.*size changed/);
  } finally {
    f.foundation.close();
  }
});

test("Discord SDK uploads verified objects with safe mentions and origin reply", async () => {
  const f = fixture();
  try {
    const artifact = await object(f, Buffer.from("sdk file"), "sdk.txt");
    const sent: Record<string, unknown>[] = [];
    const raw = {
      on: () => raw,
      channels: {
        fetch: async () => ({
          type: 0,
          send: async (payload: Record<string, unknown>) => {
            sent.push(payload);
          },
        }),
      },
      destroy: async () => undefined,
    } as unknown as Client;
    const sdk = new DiscordJsClient("offline-fixture", false, raw);
    await sdk.sendArtifact("origin", artifact, f.media, {
      replyToMessageId: "source",
    });
    const payload = sent[0]!;
    assert.deepEqual(payload.allowedMentions, {
      parse: [],
      repliedUser: false,
    });
    assert.deepEqual(payload.reply, {
      messageReference: "source",
      failIfNotExists: false,
    });
    const file = (
      payload.files as Array<{ attachment: string; name: string }>
    )[0]!;
    assert.equal(file.name, "sdk.txt");
    assert.equal(file.attachment, f.media.verifiedObjectPath(artifact));
    await assert.rejects(
      sdk.sendArtifact(
        "origin",
        { ...artifact, sha256: "0".repeat(64) },
        f.media,
      ),
      /Discord artifact delivery failed/,
    );
    assert.equal(sent.length, 1);
    // Invalid URL rejected before fetch; no live Discord/network access.
    await assert.rejects(
      sdk.downloadAttachment({
        url: "http://localhost/private",
        name: "bad",
        size: 1,
      }),
      /Discord attachment download failed/,
    );
    await sdk.close();
  } finally {
    f.foundation.close();
  }
});
