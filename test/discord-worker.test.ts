import assert from "node:assert/strict";
import test from "node:test";

import {
  DiscordWorker,
  type DiscordClient,
  type DiscordMessage,
  type DiscordOutboxDelivery,
  type DiscordStore,
} from "../src/channels/discord.js";

function incoming(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "m1",
    channelId: "c1",
    guildId: "g1",
    channelType: "guild-text",
    author: { id: "u1", name: "Alice", bot: false },
    content: "follow up",
    mentionsBot: false,
    replyToMessageId: "m0",
    timestamp: "2026-10-01T00:00:00.000Z",
    hasAttachments: false,
    ...overrides,
  };
}

class FakeClient implements DiscordClient {
  public assertHealthy(): void {}
  readonly botUserId = "999";
  readonly sent: Array<{ channelId: string; text: string; reply?: string }> =
    [];
  fetches = 0;
  #messages: DiscordMessage[];
  #abortOnConnect: AbortController | null;
  #fetchDelayMs: number;
  #abortDelayMs: number;
  #sendFailures: number;

  public constructor(
    messages: DiscordMessage | readonly DiscordMessage[],
    options: {
      abortOnConnect?: AbortController | null;
      fetchDelayMs?: number;
      abortDelayMs?: number;
      sendFailures?: number;
    } = {},
  ) {
    this.#messages = Array.isArray(messages) ? [...messages] : [messages];
    this.#abortOnConnect = options.abortOnConnect ?? null;
    this.#fetchDelayMs = options.fetchDelayMs ?? 0;
    this.#abortDelayMs = options.abortDelayMs ?? 20;
    this.#sendFailures = options.sendFailures ?? 0;
  }

  public async connect(
    onMessage: (message: DiscordMessage) => void,
  ): Promise<void> {
    for (const message of this.#messages) onMessage(message);
    if (this.#abortOnConnect !== null)
      setTimeout(() => this.#abortOnConnect?.abort(), this.#abortDelayMs);
  }

  public async fetchReferencedAuthor(): Promise<string | null> {
    this.fetches += 1;
    if (this.#fetchDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.#fetchDelayMs));
    return "999";
  }

  public async sendText(
    channelId: string,
    text: string,
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    this.sent.push({
      channelId,
      text,
      ...(options?.replyToMessageId === undefined
        ? {}
        : { reply: options.replyToMessageId }),
    });
    if (this.#sendFailures > 0) {
      this.#sendFailures -= 1;
      throw new Error("offline fixture");
    }
  }

  public async sendTyping(): Promise<void> {}
  public async close(): Promise<void> {}
}

class FakeStore implements DiscordStore {
  readonly deliveries: DiscordOutboxDelivery[] = [];
  sent = 0;
  failed = 0;
  retryable = 0;
  public runningTurnEndpoints(): [] {
    return [];
  }
  public claimOutbox(): boolean {
    return true;
  }
  public markOutboxSent(): void {
    this.sent += 1;
  }
  public markOutboxRetryable(): void {
    this.retryable += 1;
  }
  public markOutboxFailed(): void {
    this.failed += 1;
  }
  public pendingDiscordOutbox(): readonly DiscordOutboxDelivery[] {
    return this.deliveries;
  }
}

const routeApplication = (allowed: boolean, received: string[] = []) => ({
  discordRouteAllowed: () => allowed,
  receiveDiscord: (_account: string, _bot: string, value: unknown) => {
    received.push((value as DiscordMessage).id);
    return { accepted: true, duplicate: false };
  },
});

test("worker gates route before fetching, and ignores bot/webhook traffic", async () => {
  const abort = new AbortController();
  const client = new FakeClient(
    [
      incoming({ id: "unauthorized" }),
      incoming({ id: "bot", author: { id: "u2", name: "bot", bot: true } }),
      incoming({ id: "webhook", webhookId: "hook" }),
    ],
    { abortOnConnect: abort },
  );
  const store = new FakeStore();
  const received: string[] = [];
  const worker = new DiscordWorker(
    { id: "primary" },
    routeApplication(false, received),
    store,
    { client },
  );
  await worker.run(abort.signal);
  assert.equal(client.fetches, 0);
  assert.deepEqual(received, []);
});

test("worker performs reply lookup serially after admission and bounds ingress", async () => {
  const abort = new AbortController();
  const messages = Array.from({ length: 65 }, (_, index) =>
    incoming({
      id: `m-${index}`,
      replyToMessageId: `source-${index}`,
    }),
  );
  const client = new FakeClient(messages, {
    abortOnConnect: abort,
    fetchDelayMs: 1,
    abortDelayMs: 100,
  });
  const store = new FakeStore();
  const received: string[] = [];
  const worker = new DiscordWorker(
    { id: "primary" },
    routeApplication(true, received),
    store,
    { client },
  );
  await worker.run(abort.signal);
  // The 65th callback is rejected while 64 admitted callbacks drain in order.
  assert.equal(client.fetches, 64);
  assert.deepEqual(
    received,
    received.slice().sort((a, b) => {
      return Number(a.slice(2)) - Number(b.slice(2));
    }),
  );
  assert.ok(received.length <= client.fetches);
});

test("failed delivery remains retryable and cancellation after send is never marked sent", async () => {
  const client = new FakeClient(incoming(), { sendFailures: 1 });
  const store = new FakeStore();
  store.deliveries.push({
    id: "retry",
    userId: "u",
    accountId: "primary",
    kind: "text",
    privateChatId: "c1",
    text: "done",
  });
  const worker = new DiscordWorker(
    { id: "primary" },
    routeApplication(false),
    store,
    { client },
  );
  assert.equal(await worker.deliverPending(), 0);
  assert.equal(store.retryable, 1);
  assert.equal(store.sent, 0);
  assert.equal(await worker.deliverPending(), 1);
  assert.equal(store.sent, 1);

  const abort = new AbortController();
  const cancelledClient = new FakeClient(incoming());
  const originalSend = cancelledClient.sendText.bind(cancelledClient);
  cancelledClient.sendText = async (...args) => {
    await originalSend(...args);
    abort.abort();
  };
  const cancelledStore = new FakeStore();
  cancelledStore.deliveries.push({
    id: "cancel",
    userId: "u",
    accountId: "primary",
    kind: "text",
    privateChatId: "c1",
    text: "done",
  });
  const cancelledWorker = new DiscordWorker(
    { id: "primary" },
    routeApplication(false),
    cancelledStore,
    { client: cancelledClient },
  );
  assert.equal(await cancelledWorker.deliverPending(abort.signal), 0);
  assert.equal(cancelledStore.sent, 0);
  assert.equal(cancelledStore.retryable, 1);
});

test("artifact outbox rows fail terminally and text replies reference the source", async () => {
  const client = new FakeClient(incoming());
  const store = new FakeStore();
  store.deliveries.push(
    {
      id: "a",
      userId: "u",
      accountId: "primary",
      kind: "artifact",
      privateChatId: "c1",
    },
    {
      id: "t",
      userId: "u",
      accountId: "primary",
      kind: "text",
      privateChatId: "c1",
      text: "done",
      discordSource: {
        messageId: "m1",
        channelId: "c1",
        guildId: "g1",
        authorId: "u1",
        authorName: "Alice",
        timestamp: "2026-10-01T00:00:00.000Z",
      },
    },
  );
  const worker = new DiscordWorker(
    { id: "primary" },
    routeApplication(false),
    store,
    { client },
  );
  assert.equal(await worker.deliverPending(), 1);
  assert.equal(store.failed, 1);
  assert.equal(store.sent, 1);
  assert.deepEqual(client.sent[1], {
    channelId: "c1",
    text: "done",
    reply: "m1",
  });
});

test("Gateway fatal failure restarts only Discord with bounded retry and sanitized logs", async () => {
  const abort = new AbortController();
  const client = new FakeClient([]);
  let connects = 0;
  let closes = 0;
  const logs: string[] = [];
  client.connect = async () => {
    connects += 1;
    if (connects === 2) abort.abort();
  };
  client.assertHealthy = () => {
    if (connects === 1) throw new Error("raw SDK credentials must not appear");
  };
  client.close = async () => {
    closes += 1;
  };
  const store = new FakeStore();
  const worker = new DiscordWorker(
    { id: "primary" },
    routeApplication(false),
    store,
    { client, reconnectDelayMs: 1, logger: (message) => logs.push(message) },
  );
  await worker.run(abort.signal);
  assert.equal(connects, 2);
  assert.equal(closes, 2);
  assert.match(logs.join("\n"), /retrying independently/);
  assert.doesNotMatch(logs.join("\n"), /credentials/);
  assert.equal(store.sent, 0);
});
