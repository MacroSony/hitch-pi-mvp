import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchApplication } from "../src/app/application.js";
import {
  HitchStore,
  type IdSource,
  type MessageIdentity,
} from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import type { Clock } from "../src/foundation/database.js";
import { FakeAgentRuntime, type RuntimeTurn } from "../src/runtime/runtime.js";
import { nextFireAfter } from "../src/wake/next-fire.js";
import { WakeStore } from "../src/wake/store.js";
import type { WakeSchedule } from "../src/wake/types.js";

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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hitch-wake-test-"));
  chmodSync(root, 0o700);
  const paths = {
    dataRoot: join(root, "data"),
    piProfileDir: join(root, "pi"),
    wechat: join(root, "wechat"),
    alice: join(root, "alice"),
  };
  for (const path of [paths.piProfileDir, paths.wechat, paths.alice])
    privateDirectory(path);
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot: paths.dataRoot,
    piProfileDir: paths.piProfileDir,
    minimumFreeBytes: 0,
    telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_TEST_TOKEN" }],
    wechatAccounts: [{ id: "primary", stateDir: paths.wechat }],
    users: [
      {
        id: "alice",
        workspace: paths.alice,
        telegram: { account: "primary", userId: "101", privateChatId: "101" },
      },
    ],
  });
  const foundation = bootstrapFoundation(config);
  const sequence = new Sequence();
  const store = new HitchStore(foundation.database, sequence, sequence);
  const endpoint = store.resolveTelegramEndpoint("primary", "101", "101");
  assert.ok(endpoint !== null);
  const wakeStore = new WakeStore(
    join(paths.dataRoot, "users", "alice", "schedules.json"),
  );
  return { foundation, store, paths, sequence, endpoint, wakeStore };
}

function makeApp(
  environment: ReturnType<typeof setup>,
  calls: RuntimeTurn[],
  wakeGraceMs = 30 * 60_000,
): HitchApplication {
  const runtime = new FakeAgentRuntime((turn) => {
    calls.push(turn);
    return {
      outcome: "succeeded",
      text: `answer for ${turn.userId}`,
      sessionReusable: true,
    };
  });
  return new HitchApplication(
    environment.store,
    runtime,
    "always-trigger",
    undefined,
    30_000,
    (userId) => join(environment.paths.dataRoot, "users", userId),
    undefined,
    ["alice"],
    30_000,
    wakeGraceMs,
  );
}

function addDaily(
  environment: ReturnType<typeof setup>,
  promptTemplate: string,
  sessionId = "session_unbound",
): WakeSchedule {
  return environment.wakeStore.add({
    ownerId: "alice",
    channel: "telegram",
    endpointId: environment.endpoint.id,
    sessionId,
    promptTemplate,
    recurrence: { kind: "daily" },
    timeOfDay: "08:00",
    timezone: "UTC",
    enabled: true,
    maxFires: null,
    until: null,
  });
}

test("due daily schedule fires exactly once with rendered template", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(environment, calls);
  const schedule = addDaily(
    environment,
    "Morning brief for {{date}} ({{weekday}})",
  );

  const slot = nextFireAfter(schedule, Date.now());
  assert.ok(slot !== null);
  app.runWakeTick(slot + 5 * 60_000);
  await app.drain();

  assert.equal(calls.length, 1);
  const expectedDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(slot));
  assert.ok(calls[0]!.prompt.includes(expectedDate));
  assert.ok(!calls[0]!.prompt.includes("{{date}}"));

  const stored = environment.wakeStore.get(schedule.id);
  assert.equal(stored?.fireCount, 1);
  assert.equal(stored?.lastFiredAt, new Date(slot).toISOString());

  // A second tick in the same slot must not re-fire.
  app.runWakeTick(slot + 10 * 60_000);
  await app.drain();
  assert.equal(calls.length, 1);

  // The reply travels the normal outbox path.
  assert.ok(environment.store.pendingTelegramOutbox("primary").length >= 1);
});

test("slot older than the grace window is skipped without firing", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(environment, calls);
  const schedule = addDaily(environment, "stale slot");

  const slot = nextFireAfter(schedule, Date.now());
  assert.ok(slot !== null);
  app.runWakeTick(slot + 2 * 3_600_000);
  await app.drain();

  assert.equal(calls.length, 0);
  const stored = environment.wakeStore.get(schedule.id);
  assert.equal(stored?.fireCount, 0);
  assert.equal(stored?.lastFiredAt, new Date(slot).toISOString());
});

test("disabled schedule does not fire", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(environment, calls);
  const schedule = addDaily(environment, "disabled");
  environment.wakeStore.setEnabled(schedule.id, false);

  const slot = nextFireAfter(schedule, Date.now());
  assert.ok(slot !== null);
  app.runWakeTick(slot + 5 * 60_000);
  await app.drain();

  assert.equal(calls.length, 0);
  assert.equal(environment.wakeStore.get(schedule.id)?.fireCount, 0);
});

test("once schedule with a far-past slot is skipped and never fires", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(environment, calls);
  const schedule = environment.wakeStore.add({
    ownerId: "alice",
    channel: "telegram",
    endpointId: environment.endpoint.id,
    sessionId: "session_unbound",
    promptTemplate: "one shot",
    recurrence: { kind: "once", date: "2020-01-01" },
    timeOfDay: "08:00",
    timezone: "UTC",
    enabled: true,
    maxFires: null,
    until: null,
  });

  const slot = nextFireAfter(schedule, Date.now());
  assert.equal(slot, Date.UTC(2020, 0, 1, 8, 0));
  // Years later, the slot is far beyond grace: skipped, not fired.
  app.runWakeTick(Date.now());
  await app.drain();
  assert.equal(calls.length, 0);
  assert.equal(environment.wakeStore.get(schedule.id)?.fireCount, 0);
  assert.equal(
    environment.wakeStore.get(schedule.id)?.lastFiredAt,
    new Date(slot).toISOString(),
  );
});

test("wake turn is pinned to the session bound at schedule creation", async () => {
  const environment = setup();
  const calls: RuntimeTurn[] = [];
  const app = makeApp(environment, calls);

  // Create two sessions through the normal command path; the second
  // becomes the endpoint's selected session.
  const identity: MessageIdentity = {
    endpoint: environment.endpoint,
    idempotencyKey: "cmd-1",
    contentDigest: "cmd-1",
  };
  environment.store.executeCommand(
    identity,
    { kind: "new" },
    "!new",
    [],
    undefined,
  );
  const first = environment.foundation.database.connection
    .prepare("SELECT id FROM sessions ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string };
  environment.store.executeCommand(
    { ...identity, idempotencyKey: "cmd-2", contentDigest: "cmd-2" },
    { kind: "new" },
    "!new",
    [],
    undefined,
  );

  const schedule = addDaily(environment, "pinned", first.id);
  const slot = nextFireAfter(schedule, Date.now());
  assert.ok(slot !== null);
  app.runWakeTick(slot + 5 * 60_000);
  await app.drain();

  assert.equal(calls.length, 1);
  const turn = environment.foundation.database.connection
    .prepare("SELECT session_id FROM turns WHERE prompt_text = 'pinned'")
    .get() as { session_id: string };
  assert.equal(turn.session_id, first.id);
});
