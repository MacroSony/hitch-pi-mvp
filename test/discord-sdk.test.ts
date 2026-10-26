import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "discord.js";

import {
  DiscordJsClient,
  DiscordTransportError,
  discordFailureDiagnostic,
  splitDiscordText,
  type DiscordMessage,
} from "../src/channels/discord.js";

function fakeDiscordClient(options: {
  login?: () => Promise<void>;
  send?: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const handlers = new Map<string, (...args: never[]) => void>();
  const sent: Record<string, unknown>[] = [];
  const channel = {
    type: 0,
    send: async (payload: Record<string, unknown>) => {
      sent.push(payload);
      await options.send?.(payload);
    },
    sendTyping: async () => undefined,
  };
  const raw = {
    user: null as { id: string } | null,
    on(event: string, handler: (...args: never[]) => void) {
      handlers.set(event, handler);
      return raw;
    },
    login:
      options.login ??
      (async () => {
        raw.user = { id: "bot-from-ready" } as never;
      }),
    channels: { fetch: async () => channel },
    destroy: async () => undefined,
  } as unknown as Client & { user: { id: string } | null };
  return { raw, handlers, sent, channel };
}

function assertNoBrokenSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff);
      index += 1;
    } else assert.ok(code < 0xdc00 || code > 0xdfff);
  }
}

test("artifact failure diagnostics retain only safe phase and numeric codes", () => {
  const hostile = new Error(
    "token=/secret/path response body with bearer secret",
  );
  Object.defineProperties(hostile, {
    status: { value: 403, enumerable: true },
    code: { value: 50013, enumerable: true },
    headers: { value: { authorization: "bearer secret" }, enumerable: true },
    request: {
      value: { url: "/secret/path", token: "secret" },
      enumerable: true,
    },
  });
  const wrapped = DiscordTransportError.artifactFailure("upload", hostile);
  assert.deepEqual(discordFailureDiagnostic(wrapped), {
    phase: "upload",
    kind: "http",
    status: 403,
    code: 50013,
  });
  assert.equal(
    JSON.stringify(discordFailureDiagnostic(wrapped)).includes("secret"),
    false,
  );
  assert.equal(
    discordFailureDiagnostic(new Error("private details")),
    undefined,
  );

  const malicious = new Error("private");
  Object.defineProperty(malicious, "status", {
    get() {
      throw new Error("getter-secret");
    },
  });
  Object.defineProperty(malicious, "code", { value: "secret-code" });
  assert.deepEqual(
    discordFailureDiagnostic(
      DiscordTransportError.artifactFailure("channel-fetch", malicious),
    ),
    { phase: "channel-fetch", kind: "other" },
  );

  const transport = new Error("secret transport details");
  Object.defineProperty(transport, "code", {
    value: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  });
  const outer = new Error("secret wrapper");
  Object.defineProperty(outer, "cause", { value: transport });
  assert.deepEqual(
    discordFailureDiagnostic(
      DiscordTransportError.artifactFailure("upload", outer),
    ),
    {
      phase: "upload",
      kind: "network",
      transportCode: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
    },
  );

  for (const [code, kind] of [
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_ABORTED", "aborted"],
    ["ECONNRESET", "network"],
  ] as const) {
    const coded = new Error("secret");
    Object.defineProperty(coded, "code", { value: code });
    assert.deepEqual(
      discordFailureDiagnostic(
        DiscordTransportError.artifactFailure("upload", coded),
      ),
      { phase: "upload", kind, transportCode: code },
    );
  }

  const forged = new Error("secret");
  Object.defineProperty(forged, "code", { value: "secret-code" });
  assert.deepEqual(
    discordFailureDiagnostic(
      DiscordTransportError.artifactFailure("upload", forged),
    ),
    { phase: "upload", kind: "other" },
  );
});

test("SDK exposes the authenticated Ready identity, not a token-derived id", async () => {
  let tokenSeen = "";
  const fake = fakeDiscordClient({
    login: async () => {
      // A deliberately non-token-shaped value proves login owns identity.
      tokenSeen = "opaque-test-token";
      fake.raw.user = { id: "123456789012345678" } as never;
    },
  });
  const client = new DiscordJsClient("opaque-test-token", false, fake.raw);
  assert.equal(client.botUserId, null);
  await client.connect(() => undefined);
  assert.equal(tokenSeen, "opaque-test-token");
  assert.equal(client.botUserId, "123456789012345678");
  await client.close();
});

test("SDK sends bounded UTF-16 chunks with mentions and reply pings disabled", async () => {
  const fake = fakeDiscordClient({});
  const client = new DiscordJsClient("opaque", false, fake.raw);
  const emojiText = "😀".repeat(16_000) + "tail";
  const chunks = splitDiscordText(emojiText);
  assert.deepEqual(splitDiscordText(""), []);
  assert.ok(chunks.length <= 16);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2_000);
    assertNoBrokenSurrogates(chunk);
  }
  await client.sendText("channel", "hello", { replyToMessageId: "source" });
  assert.deepEqual(fake.sent[0], {
    content: "hello",
    allowedMentions: { parse: [], repliedUser: false },
    reply: { messageReference: "source", failIfNotExists: false },
  });
  await client.close();
});

test("SDK rejects cancellation before and after REST send", async () => {
  const before = fakeDiscordClient({});
  const beforeClient = new DiscordJsClient("opaque", false, before.raw);
  const beforeAbort = new AbortController();
  beforeAbort.abort();
  await assert.rejects(
    beforeClient.sendText("channel", "hello", {}, beforeAbort.signal),
    /Discord operation cancelled|delivery failed/u,
  );
  assert.equal(before.sent.length, 0);
  await beforeClient.close();

  const afterAbort = new AbortController();
  const after = fakeDiscordClient({
    send: async () => afterAbort.abort(),
  });
  const afterClient = new DiscordJsClient("opaque", false, after.raw);
  await assert.rejects(
    afterClient.sendText("channel", "hello", {}, afterAbort.signal),
    /Discord text delivery failed/u,
  );
  assert.equal(after.sent.length, 1);
  await afterClient.close();
});

// Keep the imported normalized type visible to this fixture's contract: the
// SDK callback remains normalized and never exposes discord.js objects.
const _normalizedMessageType: DiscordMessage | undefined = undefined;
void _normalizedMessageType;

test("SDK surfaces fatal shardDisconnect/invalidated without taking over normal resume", async () => {
  const fake = fakeDiscordClient({});
  const client = new DiscordJsClient("opaque", false, fake.raw);
  await client.connect(() => undefined);
  assert.doesNotThrow(() => client.assertHealthy());
  fake.handlers.get("shardError")?.();
  assert.doesNotThrow(() => client.assertHealthy());
  fake.handlers.get("shardDisconnect")?.();
  assert.throws(() => client.assertHealthy(), /requires reconnection/);
  await assert.rejects(
    client.sendText("channel", "must not send"),
    /requires reconnection/,
  );
  assert.equal(fake.sent.length, 0);
  await client.close();
  await client.connect(() => undefined);
  assert.doesNotThrow(() => client.assertHealthy());
  fake.handlers.get("invalidated")?.();
  assert.throws(() => client.assertHealthy(), /requires reconnection/);
  await client.close();
});
