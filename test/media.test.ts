import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchApplication } from "../src/app/application.js";
import { HitchStore, type IdSource } from "../src/app/store.js";
import { TelegramBotClient, TelegramWorker } from "../src/channels/telegram.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import type { Clock } from "../src/foundation/database.js";
import {
  MAX_INPUT_ARTIFACT_BYTES,
  MediaStore,
} from "../src/media/media-store.js";
import { FakeAgentRuntime, type RuntimeTurn } from "../src/runtime/runtime.js";

class Sequence implements IdSource, Clock {
  #value = 0;

  public next(kind: "session" | "pi" | "turn" | "outbox"): string {
    this.#value += 1;
    return `${kind}_${String(this.#value).padStart(8, "0")}`;
  }

  public now(): number {
    this.#value += 1;
    return this.#value;
  }
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function bytes(value: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const middle = Math.max(1, Math.floor(value.length / 2));
      yield value.subarray(0, middle);
      yield value.subarray(middle);
    },
  };
}

function textBytes(value: string): AsyncIterable<Uint8Array> {
  return bytes(Buffer.from(value));
}

function png(width = 1, height = 1): Buffer {
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hitch-media-test-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  const profile = join(root, "profile");
  const workspace = join(root, "workspace");
  privateDirectory(profile);
  privateDirectory(workspace);
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot,
    piProfileDir: profile,
    minimumFreeBytes: 0,
    telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_MEDIA_TOKEN" }],
    wechatAccounts: [],
    users: [
      {
        id: "alice",
        workspace,
        telegram: { account: "primary", userId: "101", privateChatId: "101" },
      },
    ],
  });
  const foundation = bootstrapFoundation(config);
  const sequence = new Sequence();
  const store = new HitchStore(foundation.database, sequence, sequence);
  const media = new MediaStore(dataRoot);
  return { foundation, store, media, dataRoot, workspace };
}

function documentUpdate(updateId: number, userId: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      chat: { id: userId, type: "private" },
      from: { id: userId },
      document: {
        file_id: `file-${userId}`,
        file_unique_id: `unique-${userId}`,
        file_name: "notes.txt",
        mime_type: "text/plain",
        file_size: 11,
      },
      caption: "Read this file",
    },
  };
}

test("media store streams immutable objects and rejects invalid image bounds", async () => {
  const environment = setup();
  const image = await environment.media.ingest("alice", bytes(png()), {
    advertisedBytes: png().length,
    advertisedMime: "image/png",
    displayName: "reference.png",
    expectImage: true,
  });
  assert.equal(image.mediaKind, "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(
    statSync(environment.media.objectPath(image)).mode & 0o777,
    0o400,
  );
  assert.equal(environment.media.imageData(image), png().toString("base64"));

  const ordinary = await environment.media.ingest(
    "alice",
    textBytes("ordinary file"),
    {
      advertisedBytes: 13,
      advertisedMime: "text/plain",
      displayName: "../../unsafe/name.txt",
    },
  );
  assert.equal(ordinary.mediaKind, "file");
  assert.equal(ordinary.displayName, "attachment");
  assert.ok(!environment.media.objectPath(ordinary).includes("unsafe"));
  const opaqueImage = await environment.media.ingest(
    "alice",
    textBytes('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    {
      advertisedMime: "image/svg+xml",
      displayName: "drawing.svg",
      expectImage: false,
    },
  );
  assert.equal(opaqueImage.mediaKind, "file");
  assert.equal(opaqueImage.mimeType, "image/svg+xml");
  const imagePath = environment.media.objectPath(image);
  assert.equal(
    environment.media.cleanupUnreferenced(new Set([ordinary.storageKey])),
    2,
  );
  assert.equal(existsSync(imagePath), false);

  await assert.rejects(
    () =>
      environment.media.ingest("alice", bytes(png(16_385, 1)), {
        advertisedMime: "image/png",
        expectImage: true,
      }),
    /dimensions exceed/u,
  );
  let consumed = false;
  const source: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      consumed = true;
      yield Buffer.from("never");
    },
  };
  await assert.rejects(
    () =>
      environment.media.ingest("alice", source, {
        advertisedBytes: MAX_INPUT_ARTIFACT_BYTES + 1,
      }),
    /20 MiB/u,
  );
  assert.equal(consumed, false);
  assert.deepEqual(readdirSync(join(environment.dataRoot, "media", "tmp")), []);

  writeFileSync(
    join(environment.dataRoot, "media", "tmp", "orphan.tmp"),
    "partial",
    {
      mode: 0o600,
    },
  );
  new MediaStore(environment.dataRoot);
  assert.deepEqual(readdirSync(join(environment.dataRoot, "media", "tmp")), []);
  environment.foundation.close();
});

test("Telegram media is authorized before download and delivered through the artifact outbox", async () => {
  const environment = setup();
  const turns: RuntimeTurn[] = [];
  const runtime = new FakeAgentRuntime(async (turn) => {
    turns.push(turn);
    const result = await environment.media.ingest(
      "alice",
      textBytes("generated result"),
      {
        advertisedMime: "text/plain",
        displayName: "result.txt",
      },
    );
    return {
      outcome: "succeeded",
      text: "File inspected.",
      sessionReusable: true,
      artifacts: [result],
    };
  });
  const application = new HitchApplication(environment.store, runtime);
  application.start();
  const calls: string[] = [];
  const sentFiles: Array<{ name: string; content: string }> = [];
  let updatesReturned = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url.replace(/botfixture-token/gu, "bot<redacted>"));
    if (url.endsWith("/getUpdates")) {
      const result = updatesReturned
        ? []
        : [documentUpdate(1, "101"), documentUpdate(2, "999")];
      updatesReturned = true;
      return Response.json({ ok: true, result });
    }
    if (url.endsWith("/getFile")) {
      const body = JSON.parse(String(init?.body)) as { file_id: string };
      assert.equal(body.file_id, "file-101");
      return Response.json({
        ok: true,
        result: { file_path: "documents/notes.txt", file_size: 11 },
      });
    }
    if (url.includes("/file/botfixture-token/"))
      return new Response("hello world", {
        headers: { "content-length": "11", "content-type": "text/plain" },
      });
    if (url.endsWith("/sendMessage"))
      return Response.json({ ok: true, result: { message_id: 900 } });
    if (url.endsWith("/sendDocument") || url.endsWith("/sendPhoto")) {
      assert.ok(init?.body instanceof FormData);
      const file = init.body.get(
        url.endsWith("/sendDocument") ? "document" : "photo",
      );
      assert.ok(file instanceof File);
      sentFiles.push({
        name: file.name,
        content: Buffer.from(await file.arrayBuffer()).toString("utf8"),
      });
      return Response.json({ ok: true, result: { message_id: 901 } });
    }
    throw new Error(`unexpected test URL: ${url}`);
  };
  const worker = new TelegramWorker(
    "primary",
    new TelegramBotClient("fixture-token", fetcher),
    application,
    environment.store,
    environment.media,
  );
  await worker.pollOnce();
  await application.drain();
  await worker.deliverOnce();

  assert.equal(
    calls.filter((url) => url.endsWith("/getFile")).length,
    1,
    "the unknown peer must not trigger media metadata or bytes",
  );
  assert.equal(turns.length, 1);
  const inbound = turns[0]?.artifacts?.[0];
  assert.ok(inbound !== undefined);
  assert.equal(inbound.userId, "alice");
  assert.equal(inbound.mediaKind, "file");
  assert.equal(typeof inbound.bytes, "number");
  assert.deepEqual(sentFiles, [
    { name: "result.txt", content: "generated result" },
  ]);
  const links = environment.foundation.database.connection
    .prepare(
      `SELECT ta.direction, a.user_id AS userId
       FROM turn_artifacts ta JOIN artifacts a ON a.id = ta.artifact_id
       ORDER BY ta.direction`,
    )
    .all() as unknown as Array<{ direction: string; userId: string }>;
  assert.deepEqual(
    links.map((row) => ({ ...row })),
    [
      { direction: "inbound", userId: "alice" },
      { direction: "outbound", userId: "alice" },
    ],
  );
  assert.equal(environment.store.getTelegramOffset("primary"), 3);
  environment.foundation.close();
});

test("cross-owner media is rejected and !send becomes a bounded publication Turn", async () => {
  const environment = setup();
  const foreign = await environment.media.ingest("bob", textBytes("foreign"), {
    advertisedMime: "text/plain",
  });
  const publication = await environment.media.ingest(
    "alice",
    textBytes("snapshot"),
    { advertisedMime: "text/plain", displayName: "snapshot.txt" },
  );
  const turns: RuntimeTurn[] = [];
  const application = new HitchApplication(
    environment.store,
    new FakeAgentRuntime((turn) => {
      turns.push(turn);
      return {
        outcome: "succeeded",
        text: "Published snapshot.txt.",
        sessionReusable: true,
        artifacts: [publication],
      };
    }),
  );
  application.start();
  const plain = {
    update_id: 10,
    message: {
      message_id: 110,
      chat: { id: "101", type: "private" },
      from: { id: "101" },
      text: "look",
    },
  };
  const rejected = application.receiveTelegram("primary", plain, [foreign]);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.category, "rejected");

  const send = {
    update_id: 11,
    message: {
      message_id: 111,
      chat: { id: "101", type: "private" },
      from: { id: "101" },
      text: "!send reports/result.txt",
    },
  };
  assert.equal(application.receiveTelegram("primary", send).accepted, true);
  await application.drain();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.publishPath, "reports/result.txt");
  assert.equal(
    environment.store
      .pendingTelegramOutbox("primary")
      .filter(({ kind }) => kind === "artifact").length,
    1,
  );
  environment.media.discard(foreign);
  environment.foundation.close();
});

test("configured free-space threshold stops prompt and !send admission", () => {
  const environment = setup();
  const blockedMedia = new MediaStore(
    environment.dataRoot,
    Number.MAX_SAFE_INTEGER,
  );
  const sequence = new Sequence();
  const store = new HitchStore(
    environment.foundation.database,
    sequence,
    sequence,
    (userId) => blockedMedia.assertAdmissionCapacity(userId),
  );
  const application = new HitchApplication(store, new FakeAgentRuntime());
  application.start();
  const prompt = {
    update_id: 20,
    message: {
      message_id: 120,
      chat: { id: "101", type: "private" },
      from: { id: "101" },
      text: "plain prompt",
    },
  };
  const send = {
    update_id: 21,
    message: {
      message_id: 121,
      chat: { id: "101", type: "private" },
      from: { id: "101" },
      text: "!send result.txt",
    },
  };
  assert.equal(application.receiveTelegram("primary", prompt).category, "busy");
  assert.equal(application.receiveTelegram("primary", send).category, "busy");
  assert.equal(store.count("turns"), 0);
  environment.foundation.close();
});
