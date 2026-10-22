import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { Client } from "discord.js";

import { AppError } from "../src/app/errors.js";
import { DiscordJsClient } from "../src/channels/discord.js";

const attachment = {
  url: "https://cdn.discordapp.com/attachments/offline-test",
  name: "fixture.txt",
  size: 1,
};

function fixture(mode: "normal" | "stalled" | "error" | "headers-error") {
  const parent = new AbortController();
  let downloadSignal: AbortSignal | undefined;
  let bodyController: ReadableStreamDefaultController<Uint8Array>;
  let fetches = 0;
  let cancellations = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    fetches += 1;
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    downloadSignal = init.signal;
    if (mode === "headers-error")
      throw new Error("raw credential-bearing error");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(Uint8Array.of(1));
        if (mode === "normal") controller.close();
      },
      cancel() {
        cancellations += 1;
      },
    });
    if (mode === "stalled") {
      downloadSignal.addEventListener(
        "abort",
        () => {
          bodyController.error(new Error("raw body abort error"));
        },
        { once: true },
      );
    }
    return new Response(body);
  };
  const raw = {
    on: () => raw,
    destroy: async () => undefined,
  } as unknown as Client;
  const client = new DiscordJsClient("offline-fixture", false, raw, {
    fetcher,
    timeoutMs: 10,
  });
  return {
    client,
    parent,
    signal: () => downloadSignal!,
    fetches: () => fetches,
    cancellations: () => cancellations,
    fail: () =>
      bodyController.error(new Error("raw stream error with secrets")),
    listeners: () => getEventListeners(parent.signal, "abort").length,
  };
}
function sanitized(error: unknown): boolean {
  assert.ok(error instanceof AppError);
  assert.equal(error.category, "media-invalid");
  assert.equal(error.message, "Discord attachment download failed");
  return true;
}

test("Discord CDN deadline aborts a stalled body after headers and maps the stream error", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("stalled");
  const source = await f.client.downloadAttachment(attachment, f.parent.signal);
  const iterator = source[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  assert.equal(f.listeners(), 1);
  const pending = iterator.next();
  const rejected = assert.rejects(pending, sanitized);
  context.mock.timers.tick(9);
  assert.equal(f.signal().aborted, false);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(f.signal().aborted, true);
  assert.equal(f.listeners(), 0);
  await f.client.close();
});

test("Discord CDN normal completion clears the deadline timer and parent listener", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("normal");
  const source = await f.client.downloadAttachment(attachment, f.parent.signal);
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  assert.deepEqual(chunks, [Uint8Array.of(1)]);
  assert.equal(f.listeners(), 0);
  // If the timer leaked, this would abort the still-observed download signal.
  context.mock.timers.tick(100);
  assert.equal(f.signal().aborted, false);
  f.parent.abort();
  assert.equal(f.signal().aborted, false);
  await f.client.close();
});

test("Discord CDN forwards parent cancellation throughout streaming and cleans up", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("stalled");
  const source = await f.client.downloadAttachment(attachment, f.parent.signal);
  const iterator = source[Symbol.asyncIterator]();
  await iterator.next();
  const rejected = assert.rejects(iterator.next(), sanitized);
  f.parent.abort();
  await rejected;
  assert.equal(f.signal().aborted, true);
  assert.equal(f.listeners(), 0);
  await f.client.close();
});

test("Discord CDN abandoned iteration cancels the body and removes lifecycle resources", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("stalled");
  const clear = context.mock.method(globalThis, "clearTimeout");
  const source = await f.client.downloadAttachment(attachment, f.parent.signal);
  for await (const chunk of source) {
    assert.equal(chunk[0], 1);
    break;
  }
  assert.equal(f.cancellations(), 1);
  assert.equal(f.signal().aborted, true);
  assert.equal(f.listeners(), 0);
  assert.equal(clear.mock.callCount(), 1);
  await f.client.close();
});

test("Discord CDN stream and header failures are sanitized and clean timer/listener", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const clear = context.mock.method(globalThis, "clearTimeout");
  for (const mode of ["error", "headers-error"] as const) {
    const f = fixture(mode);
    const source = await f.client.downloadAttachment(
      attachment,
      f.parent.signal,
    );
    const iterator = source[Symbol.asyncIterator]();
    if (mode === "error") {
      await iterator.next();
      f.fail();
    }
    await assert.rejects(iterator.next(), sanitized);
    assert.equal(f.listeners(), 0);
    assert.equal(f.signal().aborted, true);
    await f.client.close();
  }
  assert.equal(clear.mock.callCount(), 2);
});

test("Discord CDN unconsumed iterable owns no timer or parent listener", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("stalled");
  const source = await f.client.downloadAttachment(attachment, f.parent.signal);
  assert.equal(f.fetches(), 0);
  assert.equal(f.listeners(), 0);
  context.mock.timers.tick(100);
  const iterator = source[Symbol.asyncIterator]();
  await iterator.return?.();
  assert.equal(f.fetches(), 0);
  assert.equal(f.listeners(), 0);
  await f.client.close();
});
