import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchApplication } from "../src/app/application.js";
import { HitchStore, type IdSource } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { FakeAgentRuntime, type RuntimeTurn } from "../src/runtime/runtime.js";

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

function makeApp(
  environment: ReturnType<typeof setup>,
  runtime: FakeAgentRuntime,
  progressFlushMs = 30_000,
): HitchApplication {
  return new HitchApplication(
    environment.store,
    runtime,
    "always-trigger",
    undefined,
    progressFlushMs,
    undefined,
    undefined,
    [],
    30_000,
    30 * 60_000,
    environment.config.users,
  );
}

test("Discord server channels share a session while DMs and server stay isolated", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(
    environment,
    new FakeAgentRuntime((turn) => {
      calls.push(turn);
      return { outcome: "succeeded", text: "ok", sessionReusable: true };
    }),
  );
  app.start();

  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("s1", "10000000000000011", "member-a", "<@bot> hello", {
        guildId: "10000000000000001",
      }),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("s2", "10000000000000012", "member-b", "<@bot> second", {
        guildId: "10000000000000001",
      }),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("d1", "20000000000000021", "20000000000000001", "private"),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "d2",
        "20000000000000022",
        "20000000000000002",
        "other private",
      ),
    ).accepted,
    true,
  );
  await app.drain();

  assert.equal(calls.length, 4);
  const serverCalls = calls.filter((call) => call.userId === "server-owner");
  const dmCall = calls.find((call) => call.userId === "dm-owner-a");
  const otherDmCall = calls.find((call) => call.userId === "dm-owner-b");
  assert.equal(serverCalls.length, 2);
  assert.equal(serverCalls[0]?.sessionId, serverCalls[1]?.sessionId);
  assert.ok(dmCall && otherDmCall);
  assert.notEqual(serverCalls[0]?.sessionId, dmCall.sessionId);
  assert.notEqual(dmCall.sessionId, otherDmCall.sessionId);
  assert.equal(
    environment.store
      .pendingDiscordOutbox("bot")
      .find((delivery) => delivery.privateChatId === "10000000000000012")
      ?.discordSource?.authorId,
    "member-b",
  );
  environment.foundation.close();
});

test("Discord command admission enforces admin, trigger, and duplicate boundaries", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(
    environment,
    new FakeAgentRuntime((turn) => {
      calls.push(turn);
      return { outcome: "succeeded", text: "answer", sessionReusable: true };
    }),
  );
  app.start();
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("no", "10000000000000011", "member", "quiet", {
        guildId: "10000000000000001",
        mentionsBot: false,
      }),
    ).accepted,
    false,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("reply", "10000000000000011", "member", "follow up", {
        guildId: "10000000000000001",
        mentionsBot: false,
        referencedAuthorId: "bot-user",
        replyToMessageId: "reply-origin",
      }),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("cmd", "10000000000000011", "member", "!new nope", {
        guildId: "10000000000000001",
      }),
    ).accepted,
    false,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "admin",
        "10000000000000011",
        "30000000000000001",
        "!new shared",
        { guildId: "10000000000000001" },
      ),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("reply", "10000000000000011", "member", "follow up", {
        guildId: "10000000000000001",
        mentionsBot: false,
        referencedAuthorId: "bot-user",
        replyToMessageId: "reply-origin",
      }),
    ).duplicate,
    true,
  );
  await app.drain();
  assert.equal(calls.length, 1);
  environment.foundation.close();
});

test("Discord source, outbox, and selected session survive a real foundation close and reopen", async () => {
  const environment = setup();
  const firstCalls: RuntimeTurn[] = [];
  const firstApp = makeApp(
    environment,
    new FakeAgentRuntime((turn) => {
      firstCalls.push(turn);
      return { outcome: "succeeded", text: "first", sessionReusable: true };
    }),
  );
  firstApp.start();
  assert.equal(
    firstApp.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "persist-1",
        "10000000000000011",
        "member",
        "<@bot> remember",
        { guildId: "10000000000000001" },
      ),
    ).accepted,
    true,
  );
  await firstApp.drain();
  const oldSession = firstCalls[0]?.sessionId;
  assert.ok(oldSession);
  const before = environment.store.pendingDiscordOutbox("bot").length;
  environment.foundation.close();

  const reopened = bootstrapFoundation(environment.config);
  const reopenedStore = new HitchStore(reopened.database, environment.ids);
  const secondCalls: RuntimeTurn[] = [];
  const secondApp = new HitchApplication(
    reopenedStore,
    new FakeAgentRuntime((turn) => {
      secondCalls.push(turn);
      return { outcome: "succeeded", text: "second", sessionReusable: true };
    }),
    "always-trigger",
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    30_000,
    30 * 60_000,
    environment.config.users,
  );
  secondApp.start();
  assert.equal(
    secondApp.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "persist-2",
        "10000000000000012",
        "member",
        "<@bot> continue",
        { guildId: "10000000000000001" },
      ),
    ).accepted,
    true,
  );
  await secondApp.drain();
  assert.equal(secondCalls[0]?.sessionId, oldSession);
  assert.equal(reopenedStore.pendingDiscordOutbox("bot").length, before + 1);
  const sources = reopened.database.connection
    .prepare(
      "SELECT discord_source FROM turns WHERE discord_source IS NOT NULL ORDER BY ordinal",
    )
    .all() as Array<{ discord_source: string }>;
  assert.deepEqual(
    sources.map((row) => JSON.parse(row.discord_source).messageId),
    ["persist-1", "persist-2"],
  );
  reopened.close();
});

test("Discord new/switch is owner-wide, and a removed channel can be replaced without losing context", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(
    environment,
    new FakeAgentRuntime((turn) => {
      calls.push(turn);
      return { outcome: "succeeded", text: "ok", sessionReusable: true };
    }),
  );
  app.start();
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("base", "10000000000000011", "member", "<@bot> base", {
        guildId: "10000000000000001",
      }),
    ).accepted,
    true,
  );
  await app.drain();
  const baseSession = calls[0]?.sessionId;
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "new",
        "10000000000000011",
        "30000000000000001",
        "!new project",
        { guildId: "10000000000000001" },
      ),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "project",
        "10000000000000012",
        "member",
        "<@bot> project context",
        { guildId: "10000000000000001" },
      ),
    ).accepted,
    true,
  );
  await app.drain();
  const projectSession = calls[1]?.sessionId;
  assert.notEqual(projectSession, baseSession);
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "switch",
        "10000000000000012",
        "30000000000000001",
        "!switch session-1",
        { guildId: "10000000000000001" },
      ),
    ).accepted,
    true,
  );
  const server = environment.config.users.find(
    (user) => user.id === "server-owner",
  )!;
  (server.discord as unknown as { channelIds: string[] }).channelIds = [
    "10000000000000012",
    "10000000000000013",
  ];
  environment.foundation.close();
  const rotated = bootstrapFoundation(environment.config);
  const rotatedStore = new HitchStore(rotated.database, environment.ids);
  const rotatedCalls: RuntimeTurn[] = [];
  const rotatedApp = new HitchApplication(
    rotatedStore,
    new FakeAgentRuntime((turn) => {
      rotatedCalls.push(turn);
      return { outcome: "succeeded", text: "rotated", sessionReusable: true };
    }),
    "always-trigger",
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    30_000,
    30 * 60_000,
    environment.config.users,
  );
  rotatedApp.start();
  assert.equal(
    rotatedApp.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "rotated",
        "10000000000000013",
        "member",
        "<@bot> still here",
        { guildId: "10000000000000001" },
      ),
    ).accepted,
    true,
  );
  await rotatedApp.drain();
  assert.equal(rotatedCalls[0]?.sessionId, baseSession);
  rotated.close();
});

test("Discord rejects cross-DM sessions, non-admin controls, raw slash/LOCAL, media, and keeps progress out of outbound replies", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(
    environment,
    new FakeAgentRuntime(async (turn, _signal, progress) => {
      calls.push(turn);
      progress("private progress");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { outcome: "succeeded", text: "final", sessionReusable: true };
    }),
    0,
  );
  app.start();
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "server-new",
        "10000000000000011",
        "30000000000000001",
        "!new server-session",
        { guildId: "10000000000000001" },
      ),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage(
        "dm-switch",
        "20000000000000021",
        "20000000000000001",
        "!switch server-session",
      ),
    ).accepted,
    false,
  );
  for (const [id, text, options] of [
    ["abort", "!abort", {}],
    ["model", "!model fixture/model", {}],
    ["new", "!new denied", {}],
    ["slash", "/status", {}],
    ["local", "!send report.txt", {}],
    ["media", "hello", { hasAttachments: true }],
  ] as const) {
    assert.equal(
      app.receiveDiscord(
        "bot",
        "bot-user",
        discordMessage(id, "10000000000000011", "member", text, {
          guildId: "10000000000000001",
          ...options,
        }),
      ).accepted,
      false,
    );
  }
  assert.equal(
    app.receiveDiscord(
      "bot",
      "bot-user",
      discordMessage("prompt", "10000000000000011", "member", "<@bot> work", {
        guildId: "10000000000000001",
      }),
    ).accepted,
    true,
  );
  await app.drain();
  assert.equal(calls.length, 1);
  assert.equal(
    environment.store
      .pendingDiscordOutbox("bot")
      .filter((delivery) => delivery.text === "private progress").length,
    0,
  );
  assert.equal(
    environment.store
      .pendingDiscordOutbox("bot")
      .some((delivery) => delivery.text === "final"),
    true,
  );
  environment.foundation.close();
});
