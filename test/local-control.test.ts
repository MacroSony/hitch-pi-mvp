import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchApplication } from "../src/app/application.js";
import { HitchStore } from "../src/app/store.js";
import { AppError } from "../src/app/errors.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { createLocalHandler } from "../src/local/control.js";
import {
  LocalControlError,
  LOCAL_METHODS,
  type LocalCallerConfig,
} from "../src/local/types.js";
import { FakeAgentRuntime } from "../src/runtime/runtime.js";
import { nextFireAfter } from "../src/wake/next-fire.js";

function setup(runtime: FakeAgentRuntime = new FakeAgentRuntime()) {
  const root = mkdtempSync(join(tmpdir(), "hitch-local-control-"));
  chmodSync(root, 0o700);
  const data = join(root, "data");
  const pi = join(root, "pi");
  const alice = join(root, "alice");
  const bob = join(root, "bob");
  for (const path of [pi, alice, bob])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot: data,
    piProfileDir: pi,
    minimumFreeBytes: 0,
    telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_TEST_TOKEN" }],
    wechatAccounts: [],
    users: [
      {
        id: "alice",
        workspace: alice,
        telegram: { account: "primary", userId: "1", privateChatId: "1" },
      },
      {
        id: "bob",
        workspace: bob,
        telegram: { account: "primary", userId: "2", privateChatId: "2" },
      },
    ],
  });
  const foundation = bootstrapFoundation(config);
  const store = new HitchStore(foundation.database);
  const application = new HitchApplication(
    store,
    runtime,
    "always-trigger",
    undefined,
    30_000,
    join(data, "users"),
  );
  const caller: LocalCallerConfig = {
    id: "caller",
    tokenEnv: "TOKEN",
    userIds: ["alice"],
    actions: LOCAL_METHODS,
  };
  return { root, config, foundation, store, application, caller };
}

function addSession(environment: ReturnType<typeof setup>, id: string): void {
  const now = Date.now();
  const db = environment.foundation.database.connection;
  db.prepare(
    `INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at)
     VALUES (?, 'alice', ?, ?, 'active', ?, ?)`,
  ).run(id, id, `${id}-pi`, now, now);
}

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

function dailyAtNextMinute(): string {
  const date = new Date(Date.now() + 60_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function close(environment: ReturnType<typeof setup>): void {
  environment.foundation.close();
  rmSync(environment.root, { recursive: true, force: true });
}

test("local notify is literal, owner scoped, and durably idempotent", () => {
  const environment = setup();
  try {
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    const first = handler(environment.caller, {
      method: "notify",
      params: { requestId: "n1", userId: "alice", text: "literal" },
    }) as Record<string, unknown>;
    assert.deepEqual(first.status, "queued");
    assert.equal(first.duplicate, false);
    const second = handler(environment.caller, {
      method: "notify",
      params: { requestId: "n1", userId: "alice", text: "literal" },
    }) as Record<string, unknown>;
    assert.equal(second.duplicate, true);
    assert.equal(second.deliveryId, first.deliveryId);
    assert.throws(
      () =>
        handler(environment.caller, {
          method: "notify",
          params: { requestId: "n1", userId: "alice", text: "changed" },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "conflict",
    );
    assert.throws(
      () =>
        handler(environment.caller, {
          method: "notify",
          params: { requestId: "n2", userId: "bob", text: "wrong target" },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "forbidden",
    );
    const targets = handler(environment.caller, {
      method: "targets.list",
      params: {},
    }) as { users: unknown[] };
    assert.equal(targets.users.length, 1);
    assert.equal(JSON.stringify(targets).includes("workspace"), false);
  } finally {
    close(environment);
  }
});

test("local request idempotency survives a real database reopen", () => {
  const environment = setup();
  try {
    const firstHandler = createLocalHandler(
      environment.store,
      environment.application,
    );
    const first = firstHandler(environment.caller, {
      method: "notify",
      params: { requestId: "reopen-1", userId: "alice", text: "persisted" },
    }) as { deliveryId: string; duplicate: boolean };
    assert.equal(first.duplicate, false);
    environment.foundation.close();
    const reopenedFoundation = bootstrapFoundation(environment.config);
    const reopenedStore = new HitchStore(reopenedFoundation.database);
    const reopenedApplication = new HitchApplication(
      reopenedStore,
      new FakeAgentRuntime(),
      "always-trigger",
      undefined,
      30_000,
      join(environment.config.dataRoot, "users"),
    );
    const replay = createLocalHandler(reopenedStore, reopenedApplication)(
      environment.caller,
      {
        method: "notify",
        params: { requestId: "reopen-1", userId: "alice", text: "persisted" },
      },
    ) as { deliveryId: string; duplicate: boolean };
    assert.equal(replay.duplicate, true);
    assert.equal(replay.deliveryId, first.deliveryId);
    reopenedFoundation.close();
  } finally {
    rmSync(environment.root, { recursive: true, force: true });
  }
});

test("local notify schedules use the outbox without a model and cancellation is terminal", () => {
  const environment = setup();
  try {
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    const date = tomorrow();
    const create = handler(environment.caller, {
      method: "schedule.create",
      params: {
        requestId: "s1",
        userId: "alice",
        action: "notify",
        text: "scheduled literal",
        timeOfDay: "00:00",
        timezone: "UTC",
        recurrence: { kind: "once", date },
      },
    }) as { scheduleId: string; duplicate: boolean };
    assert.equal(create.duplicate, false);
    const createReplay = handler(environment.caller, {
      method: "schedule.create",
      params: {
        requestId: "s1",
        userId: "alice",
        action: "notify",
        text: "scheduled literal",
        timeOfDay: "00:00",
        timezone: "UTC",
        recurrence: { kind: "once", date },
      },
    }) as { scheduleId: string; duplicate: boolean };
    assert.equal(createReplay.scheduleId, create.scheduleId);
    assert.equal(createReplay.duplicate, true);
    environment.application.runWakeTick(Date.parse(`${date}T00:00:00.000Z`));
    const outbox = environment.store.pendingTelegramOutbox("primary");
    assert.equal(
      outbox.filter((item) => item.text === "scheduled literal").length,
      1,
    );
    const cancel = handler(environment.caller, {
      method: "schedule.cancel",
      params: {
        requestId: "s2",
        userId: "alice",
        scheduleId: create.scheduleId,
      },
    }) as { cancelled: boolean };
    assert.equal(cancel.cancelled, true);
    const replay = handler(environment.caller, {
      method: "schedule.cancel",
      params: {
        requestId: "s2",
        userId: "alice",
        scheduleId: create.scheduleId,
      },
    }) as { duplicate: boolean; cancelled: boolean };
    assert.equal(replay.duplicate, true);
    assert.equal(replay.cancelled, true);
    assert.throws(
      () =>
        handler(environment.caller, {
          method: "schedule.set_enabled",
          params: {
            requestId: "s3",
            userId: "alice",
            scheduleId: create.scheduleId,
            enabled: true,
          },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "conflict",
    );
  } finally {
    close(environment);
  }
});

test("local schedule creation reconciles an on-disk schedule after a receipt crash", () => {
  const environment = setup();
  try {
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    const base = {
      requestId: "crash-1",
      userId: "alice",
      action: "notify",
      text: "first",
      timeOfDay: "00:00",
      timezone: "UTC",
      recurrence: { kind: "once", date: tomorrow() },
    };
    const first = handler(environment.caller, {
      method: "schedule.create",
      params: base,
    }) as { scheduleId: string };
    environment.foundation.database.connection
      .prepare(
        "DELETE FROM local_requests WHERE caller_id = ? AND request_id = ?",
      )
      .run("caller", "crash-1");
    const same = handler(environment.caller, {
      method: "schedule.create",
      params: base,
    }) as { scheduleId: string; duplicate: boolean };
    assert.equal(same.scheduleId, first.scheduleId);
    assert.equal(same.duplicate, true);
    environment.foundation.database.connection
      .prepare(
        "DELETE FROM local_requests WHERE caller_id = ? AND request_id = ?",
      )
      .run("caller", "crash-1");
    assert.throws(
      () =>
        handler(environment.caller, {
          method: "schedule.create",
          params: { ...base, text: "changed" },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "conflict",
    );
    assert.equal(
      environment.application.localWakeStore("alice").list("alice").length,
      1,
    );
  } finally {
    close(environment);
  }
});

test("same caller/request crash retry cannot cross users or callers", () => {
  const environment = setup();
  try {
    const both: LocalCallerConfig = {
      ...environment.caller,
      userIds: ["alice", "bob"],
    };
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    const params = {
      requestId: "cross-user",
      userId: "alice",
      action: "notify",
      text: "same",
      timeOfDay: "00:00",
      timezone: "UTC",
      recurrence: { kind: "once", date: tomorrow() },
    };
    const created = handler(both, { method: "schedule.create", params }) as {
      scheduleId: string;
    };
    environment.foundation.database.connection
      .prepare(
        "DELETE FROM local_requests WHERE caller_id = ? AND request_id = ?",
      )
      .run("caller", "cross-user");
    assert.throws(
      () =>
        handler(both, {
          method: "schedule.create",
          params: { ...params, userId: "bob" },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "conflict",
    );
    const other: LocalCallerConfig = { ...both, id: "other" };
    assert.throws(
      () =>
        handler(other, {
          method: "schedule.cancel",
          params: {
            requestId: "other-cancel",
            userId: "alice",
            scheduleId: created.scheduleId,
          },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "not-found",
    );
  } finally {
    close(environment);
  }
});

test("local action, owner, and ambiguous-channel checks fail closed", () => {
  const environment = setup();
  try {
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    const denied: LocalCallerConfig = {
      ...environment.caller,
      actions: ["targets.list"],
    };
    assert.throws(
      () =>
        handler(denied, {
          method: "notify",
          params: { requestId: "d1", userId: "alice", text: "x" },
        }),
      /forbidden/u,
    );
    assert.throws(
      () =>
        handler(environment.caller, {
          method: "notify",
          params: { requestId: "d2", userId: "bob", text: "x" },
        }),
      /forbidden/u,
    );
    const db = environment.foundation.database.connection;
    db.prepare(
      `INSERT INTO channel_endpoints(id, tuple_key, user_id, kind, account_id, platform_user_id, private_chat_id, selected_session_id, enabled, published_at, updated_at)
       VALUES ('ep_alice_2', 'telegram:primary:alice-2:alice-2', 'alice', 'telegram', 'primary', 'alice-2', 'alice-2', NULL, 1, ?, ?)`,
    ).run(Date.now(), Date.now());
    assert.throws(
      () =>
        handler(environment.caller, {
          method: "notify",
          params: { requestId: "d3", userId: "alice", text: "x" },
        }),
      /rejected/u,
    );
  } finally {
    close(environment);
  }
});

test("wake dispatch requires its active owned session, while notify stays literal and model-free", () => {
  let modelCalls = 0;
  const environment = setup(
    new FakeAgentRuntime(() => {
      modelCalls += 1;
      return { outcome: "succeeded", text: "ok", sessionReusable: true };
    }),
  );
  try {
    addSession(environment, "session_wake");
    addSession(environment, "session_fallback");
    const endpoint = environment.store.resolveTelegramEndpoint(
      "primary",
      "1",
      "1",
    );
    assert.ok(endpoint !== null);
    environment.foundation.database.connection
      .prepare(
        "UPDATE channel_endpoints SET selected_session_id = ? WHERE id = ?",
      )
      .run("session_fallback", endpoint.id);
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    const wake = handler(environment.caller, {
      method: "schedule.create",
      params: {
        requestId: "w1",
        userId: "alice",
        action: "wake",
        text: "wake {{date}}",
        timeOfDay: dailyAtNextMinute(),
        timezone: "UTC",
        sessionId: "session_wake",
        recurrence: { kind: "daily" },
      },
    }) as { scheduleId: string };
    const notify = handler(environment.caller, {
      method: "schedule.create",
      params: {
        requestId: "n-w1",
        userId: "alice",
        action: "notify",
        text: "notify {{date}}",
        timeOfDay: dailyAtNextMinute(),
        timezone: "UTC",
        recurrence: { kind: "daily" },
      },
    }) as { scheduleId: string };
    environment.foundation.database.connection
      .prepare("UPDATE sessions SET state = 'stopped' WHERE id = ?")
      .run("session_wake");
    const wakeSchedule = environment.application
      .localWakeStore("alice")
      .get(wake.scheduleId);
    assert.ok(wakeSchedule !== undefined);
    const wakeSlot = nextFireAfter(wakeSchedule, Date.now());
    assert.ok(wakeSlot !== null);
    environment.application.runWakeTick(wakeSlot + 1_000);
    const storedWake = environment.application
      .localWakeStore("alice")
      .get(wake.scheduleId);
    assert.equal(storedWake?.lastOutcome?.status, "failed");
    assert.equal(environment.store.hasDispatchableTurn("alice"), false);
    assert.equal(modelCalls, 0);
    const notifySchedule = environment.application
      .localWakeStore("alice")
      .get(notify.scheduleId);
    assert.ok(notifySchedule !== undefined);
    const notifySlot = nextFireAfter(notifySchedule, Date.now());
    assert.ok(notifySlot !== null);
    environment.application.runWakeTick(notifySlot + 1_000);
    assert.equal(modelCalls, 0);
    assert.equal(
      environment.store
        .pendingTelegramOutbox("primary")
        .filter((item) => item.text === "notify {{date}}").length,
      1,
    );
  } finally {
    close(environment);
  }
});

test("wake queue-full dispatch records skipped rather than queued", () => {
  const environment = setup();
  try {
    addSession(environment, "session_full");
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    const schedule = handler(environment.caller, {
      method: "schedule.create",
      params: {
        requestId: "full-schedule",
        userId: "alice",
        action: "wake",
        text: "full",
        timeOfDay: dailyAtNextMinute(),
        timezone: "UTC",
        sessionId: "session_full",
        recurrence: { kind: "daily" },
      },
    }) as { scheduleId: string };
    const endpoint = environment.store.resolveTelegramEndpoint(
      "primary",
      "1",
      "1",
    );
    assert.ok(endpoint !== null);
    for (let i = 0; i < 4; i += 1) {
      environment.store.admitPrompt(
        { endpoint, idempotencyKey: `full-${i}`, contentDigest: `full-${i}` },
        `full-${i}`,
      );
    }
    const stored = environment.application
      .localWakeStore("alice")
      .get(schedule.scheduleId);
    assert.ok(stored !== undefined);
    const slot = nextFireAfter(stored, Date.now());
    assert.ok(slot !== null);
    environment.application.runWakeTick(slot + 1_000);
    const after = environment.application
      .localWakeStore("alice")
      .get(schedule.scheduleId);
    assert.equal(after?.lastOutcome?.status, "skipped");
    assert.equal(after?.lastOutcome?.turnId, undefined);
  } finally {
    close(environment);
  }
});

test("local mutation rate rejects the thirty-first request", () => {
  const environment = setup();
  try {
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    for (let i = 0; i < 30; i += 1) {
      handler(environment.caller, {
        method: "notify",
        params: { requestId: `rate-${i}`, userId: "alice", text: "rate" },
      });
    }
    assert.throws(
      () =>
        handler(environment.caller, {
          method: "notify",
          params: { requestId: "rate-30", userId: "alice", text: "rate" },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "busy",
    );
  } finally {
    close(environment);
  }
});

test("invalid recurrence dates are rejected before schedule creation", () => {
  const environment = setup();
  try {
    const handler = createLocalHandler(
      environment.store,
      environment.application,
    );
    assert.throws(
      () =>
        handler(environment.caller, {
          method: "schedule.create",
          params: {
            requestId: "bad-date",
            userId: "alice",
            action: "notify",
            text: "x",
            timeOfDay: "00:00",
            timezone: "UTC",
            recurrence: { kind: "once", date: "2026-02-30" },
          },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "rejected",
    );
    assert.equal(
      environment.application.localWakeStore("alice").list("alice").length,
      0,
    );
  } finally {
    close(environment);
  }
});

test("two schedules for the same endpoint and minute remain distinct", () => {
  const e = setup();
  try {
    const handler = createLocalHandler(e.store, e.application);
    const date = tomorrow();
    for (const requestId of ["first", "second"]) {
      handler(e.caller, {
        method: "schedule.create",
        params: {
          requestId,
          userId: "alice",
          action: "notify",
          text: requestId,
          timeOfDay: "00:00",
          timezone: "UTC",
          recurrence: { kind: "once", date },
        },
      });
    }
    e.application.runWakeTick(Date.parse(`${date}T00:00:00Z`));
    const rows = e.store.pendingTelegramOutbox("primary");
    assert.deepEqual(rows.map((x) => x.text).sort(), ["first", "second"]);
    assert.notEqual(rows[0]?.id, rows[1]?.id);
  } finally {
    close(e);
  }
});

test("file-before-receipt replay survives stopped session and disabled endpoint", () => {
  const e = setup();
  try {
    addSession(e, "briefing");
    const handler = createLocalHandler(e.store, e.application);
    const request = {
      method: "schedule.create" as const,
      params: {
        requestId: "crash-stopped",
        userId: "alice",
        action: "wake",
        text: "briefing",
        sessionId: "briefing",
        timeOfDay: "00:00",
        timezone: "UTC",
        recurrence: { kind: "once", date: tomorrow() },
      },
    };
    const first = handler(e.caller, request) as { scheduleId: string };
    e.foundation.database.connection.exec(
      "DELETE FROM local_requests; UPDATE sessions SET state='stopped' WHERE id='briefing'; UPDATE channel_endpoints SET enabled=0 WHERE user_id='alice';",
    );
    const retried = handler(e.caller, request) as {
      scheduleId: string;
      duplicate: boolean;
    };
    assert.equal(retried.scheduleId, first.scheduleId);
    assert.equal(retried.duplicate, true);
    assert.equal(e.application.localWakeStore("alice").list().length, 1);
  } finally {
    close(e);
  }
});

test("new past-due one-shot reminder is rejected before creating a schedule", () => {
  const e = setup();
  try {
    const handler = createLocalHandler(e.store, e.application);
    assert.throws(
      () =>
        handler(e.caller, {
          method: "schedule.create",
          params: {
            requestId: "past",
            userId: "alice",
            action: "notify",
            text: "past event",
            timeOfDay: "00:00",
            timezone: "UTC",
            recurrence: { kind: "once", date: "2000-01-01" },
          },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "rejected",
    );
    assert.equal(e.application.localWakeStore("alice").list().length, 0);
    assert.equal(e.store.localRequest(e.caller.id, "past"), null);
  } finally {
    close(e);
  }
});

test("literal local and scheduled notifications honor the disk admission guard", () => {
  const e = setup();
  try {
    const store = new HitchStore(
      e.foundation.database,
      undefined,
      undefined,
      () => {
        throw new AppError("busy", "fixture capacity");
      },
    );
    const handler = createLocalHandler(store, e.application);
    assert.throws(
      () =>
        handler(e.caller, {
          method: "notify",
          params: {
            requestId: "disk-full",
            userId: "alice",
            text: "must not insert",
          },
        }),
      (error: unknown) =>
        error instanceof LocalControlError && error.code === "busy",
    );
    const endpoint = store.localEndpointCandidates("alice")[0]!.endpoint.id;
    assert.throws(
      () =>
        store.enqueueScheduledNotice(
          "wk_00000000",
          new Date().toISOString(),
          "alice",
          endpoint,
          "must not insert",
        ),
      AppError,
    );
    assert.equal(store.pendingTelegramOutbox("primary").length, 0);
    assert.equal(store.localRequest(e.caller.id, "disk-full"), null);
  } finally {
    close(e);
  }
});
