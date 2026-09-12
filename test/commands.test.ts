import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand, HELP_TEXT } from "../src/app/commands.js";
import { AppError } from "../src/app/errors.js";
import { HitchApplication } from "../src/app/application.js";
import type { WakeSchedule } from "../src/wake/types.js";
import type { EndpointContext, MessageIdentity } from "../src/app/store.js";
import { FakeAgentRuntime } from "../src/runtime/runtime.js";

class FakeWakeStore {
  public fileError: string | null = null;
  public defaultTz = new Map<string, string>();
  public schedules = new Map<string, WakeSchedule>();
  public reloaded = false;

  public reloadIfChanged(): void {
    this.reloaded = true;
  }

  public list(ownerId?: string): WakeSchedule[] {
    const all = Array.from(this.schedules.values());
    return ownerId ? all.filter((s) => s.ownerId === ownerId) : all;
  }

  public get(id: string): WakeSchedule | null {
    return this.schedules.get(id) ?? null;
  }

  public add(
    input: Omit<WakeSchedule, "id" | "fireCount" | "lastFiredAt" | "createdAt">,
  ): WakeSchedule {
    const id = `sched_${String(this.schedules.size + 1).padStart(3, "0")}`;
    const item: WakeSchedule = {
      ...input,
      id,
      fireCount: 0,
      lastFiredAt: null,
      createdAt: "2026-09-12T00:00:00.000Z",
    };
    this.schedules.set(id, item);
    return item;
  }

  public remove(id: string): boolean {
    return this.schedules.delete(id);
  }

  public setEnabled(id: string, enabled: boolean): boolean {
    const s = this.schedules.get(id);
    if (!s) return false;
    (s as { enabled: boolean }).enabled = enabled;
    return true;
  }

  public recordFire(id: string, isoUtc: string): void {
    const s = this.schedules.get(id);
    if (s) {
      (s as { fireCount: number }).fireCount += 1;
      (s as { lastFiredAt: string }).lastFiredAt = isoUtc;
    }
  }

  public getDefaultTimezone(ownerId: string): string | null {
    return this.defaultTz.get(ownerId) ?? null;
  }

  public setDefaultTimezone(ownerId: string, tz: string): void {
    this.defaultTz.set(ownerId, tz);
  }
}

function makeIdentity(
  userId = "alice",
  endpointId = "endpoint_1",
): MessageIdentity {
  const endpoint: EndpointContext = {
    id: endpointId,
    userId,
    accountId: "primary",
    platformUserId: "101",
    privateChatId: "101",
  };
  return {
    endpoint,
    idempotencyKey: "idem_1",
    contentDigest: "digest_1",
  };
}

test("parseCommand parses !wake list", () => {
  const cmd = parseCommand("!wake list");
  assert.deepEqual(cmd, { kind: "wake", action: "list" });
});

test("parseCommand rejects !wake list with extra arguments", () => {
  assert.throws(
    () => parseCommand("!wake list extra"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("unexpected argument for !wake list"),
  );
});

test("parseCommand parses !wake del, pause, resume", () => {
  assert.deepEqual(parseCommand("!wake del sched_1"), {
    kind: "wake",
    action: "del",
    id: "sched_1",
  });
  assert.deepEqual(parseCommand("!wake pause sched_2"), {
    kind: "wake",
    action: "pause",
    id: "sched_2",
  });
  assert.deepEqual(parseCommand("!wake resume sched_3"), {
    kind: "wake",
    action: "resume",
    id: "sched_3",
  });
});

test("parseCommand rejects !wake del/pause/resume with missing or extra args", () => {
  assert.throws(
    () => parseCommand("!wake del"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("schedule id is required"),
  );
  assert.throws(
    () => parseCommand("!wake pause"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("schedule id is required"),
  );
  assert.throws(
    () => parseCommand("!wake resume"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("schedule id is required"),
  );
  assert.throws(
    () => parseCommand("!wake del id1 id2"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("unexpected argument for !wake del"),
  );
});

test("parseCommand parses !wake tz", () => {
  assert.deepEqual(parseCommand("!wake tz Asia/Shanghai"), {
    kind: "wake",
    action: "tz",
    tz: "Asia/Shanghai",
  });
  assert.deepEqual(parseCommand("!wake tz UTC"), {
    kind: "wake",
    action: "tz",
    tz: "UTC",
  });
});

test("parseCommand rejects invalid !wake tz", () => {
  assert.throws(
    () => parseCommand("!wake tz"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("timezone is required"),
  );
  assert.throws(
    () => parseCommand("!wake tz Bad/Timezone"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid timezone"),
  );
  assert.throws(
    () => parseCommand("!wake tz UTC extra"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("unexpected argument for !wake tz"),
  );
});

test("parseCommand parses !wake add daily", () => {
  assert.deepEqual(parseCommand("!wake add daily 08:30 Wake up!"), {
    kind: "wake",
    action: "add",
    recurrence: { kind: "daily" },
    timeOfDay: "08:30",
    prompt: "Wake up!",
  });

  assert.deepEqual(
    parseCommand("!wake add daily 08:30 --tz Asia/Shanghai Check morning news"),
    {
      kind: "wake",
      action: "add",
      recurrence: { kind: "daily" },
      timeOfDay: "08:30",
      tz: "Asia/Shanghai",
      prompt: "Check morning news",
    },
  );
});

test("parseCommand parses !wake add weekly", () => {
  assert.deepEqual(
    parseCommand("!wake add weekly mon,wed,fri 09:00 Team standup reminder"),
    {
      kind: "wake",
      action: "add",
      recurrence: { kind: "weekly", weekdays: [1, 3, 5] },
      timeOfDay: "09:00",
      prompt: "Team standup reminder",
    },
  );

  assert.deepEqual(
    parseCommand(
      "!wake add weekly sun 10:00 --tz America/New_York Weekly review",
    ),
    {
      kind: "wake",
      action: "add",
      recurrence: { kind: "weekly", weekdays: [0] },
      timeOfDay: "10:00",
      tz: "America/New_York",
      prompt: "Weekly review",
    },
  );
});

test("parseCommand parses !wake add once", () => {
  assert.deepEqual(
    parseCommand("!wake add once 2026-10-01 14:00 Run scheduled upgrade"),
    {
      kind: "wake",
      action: "add",
      recurrence: { kind: "once", date: "2026-10-01" },
      timeOfDay: "14:00",
      prompt: "Run scheduled upgrade",
    },
  );

  assert.deepEqual(
    parseCommand("!wake add once 2028-02-29 12:00 --tz UTC Leap day check"),
    {
      kind: "wake",
      action: "add",
      recurrence: { kind: "once", date: "2028-02-29" },
      timeOfDay: "12:00",
      tz: "UTC",
      prompt: "Leap day check",
    },
  );
});

test("parseCommand rejects invalid !wake add subcommands and parameters", () => {
  assert.throws(
    () => parseCommand("!wake add"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("recurrence type is required"),
  );

  assert.throws(
    () => parseCommand("!wake add monthly 08:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("unknown recurrence type: monthly"),
  );

  // Daily errors
  assert.throws(
    () => parseCommand("!wake add daily"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("time is required"),
  );
  assert.throws(
    () => parseCommand("!wake add daily 25:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid time format"),
  );
  assert.throws(
    () => parseCommand("!wake add daily 08:60 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid time format"),
  );
  assert.throws(
    () => parseCommand("!wake add daily 8:30 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid time format"),
  );
  assert.throws(
    () => parseCommand("!wake add daily 08:30"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("prompt is required"),
  );

  // Weekly errors
  assert.throws(
    () => parseCommand("!wake add weekly"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("weekdays are required"),
  );
  assert.throws(
    () => parseCommand("!wake add weekly mon,foo 09:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid weekday token: foo"),
  );
  assert.throws(
    () => parseCommand("!wake add weekly monday 09:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid weekday token: monday"),
  );
  assert.throws(
    () => parseCommand("!wake add weekly mon,,fri 09:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid weekday token"),
  );
  assert.throws(
    () => parseCommand("!wake add weekly mon,wed"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("time is required"),
  );
  assert.throws(
    () => parseCommand("!wake add weekly mon,wed 09:00"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("prompt is required"),
  );

  // Once errors
  assert.throws(
    () => parseCommand("!wake add once"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("date is required"),
  );
  assert.throws(
    () => parseCommand("!wake add once 2026-02-29 14:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid date: 2026-02-29"),
  );
  assert.throws(
    () => parseCommand("!wake add once 2026-13-01 14:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid date: 2026-13-01"),
  );
  assert.throws(
    () => parseCommand("!wake add once 2026-04-31 14:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid date: 2026-04-31"),
  );
  assert.throws(
    () => parseCommand("!wake add once 2026-10-01"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("time is required"),
  );
  assert.throws(
    () => parseCommand("!wake add once 2026-10-01 14:00"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("prompt is required"),
  );

  // --tz errors
  assert.throws(
    () => parseCommand("!wake add daily 08:30 --tz"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("timezone is required after --tz"),
  );
  assert.throws(
    () => parseCommand("!wake add daily 08:30 --tz Bad/Tz prompt"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid timezone"),
  );
  assert.throws(
    () => parseCommand("!wake add daily 08:30 --tz Asia/Shanghai"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("prompt is required"),
  );
});

test("parseCommand handles --tz position strictly", () => {
  // If --tz is before time, it is rejected as invalid time
  assert.throws(
    () => parseCommand("!wake add daily --tz UTC 08:00 hello"),
    (err: unknown) =>
      err instanceof AppError &&
      err.category === "rejected" &&
      err.message.includes("invalid time format: --tz"),
  );

  // If --tz is inside prompt (after prompt started), it is preserved as prompt text
  const cmd = parseCommand("!wake add daily 08:00 check --tz UTC status");
  assert.deepEqual(cmd, {
    kind: "wake",
    action: "add",
    recurrence: { kind: "daily" },
    timeOfDay: "08:00",
    prompt: "check --tz UTC status",
  });
});

test("HELP_TEXT contains !wake command description", () => {
  assert.match(HELP_TEXT, /!wake/u);
  assert.match(HELP_TEXT, /!wake \[add\|list\|del\|pause\|resume\|tz\]/u);
});

test("existing commands parse unchanged", () => {
  assert.deepEqual(parseCommand("!new test-session"), {
    kind: "new",
    name: "test-session",
  });
  assert.deepEqual(parseCommand("!sessions"), { kind: "sessions" });
  assert.deepEqual(parseCommand("!switch s1"), {
    kind: "switch",
    selector: "s1",
  });
  assert.deepEqual(parseCommand("!status"), { kind: "status" });
  assert.deepEqual(parseCommand("!abort"), { kind: "abort" });
  assert.deepEqual(parseCommand("!stop"), { kind: "stop" });
  assert.deepEqual(parseCommand("!recover"), { kind: "recover" });
  assert.deepEqual(parseCommand("!models gpt"), {
    kind: "models",
    filter: "gpt",
  });
  assert.deepEqual(parseCommand("!model openai/gpt-4o"), {
    kind: "model",
    selector: "openai/gpt-4o",
  });
  assert.deepEqual(parseCommand("!thinking high"), {
    kind: "thinking",
    level: "high",
  });
  assert.deepEqual(parseCommand("!preset list"), {
    kind: "preset",
    action: "list",
  });
  assert.deepEqual(parseCommand("!profile use p1"), {
    kind: "profile",
    action: "use",
    id: "p1",
  });
  assert.deepEqual(parseCommand("!send path/to/file.txt"), {
    kind: "send",
    path: "path/to/file.txt",
  });
  assert.deepEqual(parseCommand("!help"), { kind: "help" });
  assert.deepEqual(parseCommand("!unknowncmd"), {
    kind: "unknown",
    name: "unknowncmd",
  });
});

test("HitchApplication.handleWakeCommand handles add, list, del, pause, resume, tz", () => {
  const fakeStore = new FakeWakeStore();
  const stores = new Map<string, FakeWakeStore>();
  const app = new HitchApplication(
    {} as any,
    new FakeAgentRuntime(),
    "always-trigger",
    undefined,
    30_000,
    undefined,
    (userId: string) => {
      let s = stores.get(userId);
      if (!s) {
        s = fakeStore;
        stores.set(userId, s);
      }
      return s as any;
    },
  );

  const identity = makeIdentity("alice", "ep_1");

  // 1. Initially list is empty
  const emptyList = app.handleWakeCommand(
    identity,
    { kind: "wake", action: "list" },
    "telegram",
    "session_123",
  );
  assert.equal(emptyList, "No wake schedules configured.");

  // 2. Set default timezone
  const tzResp = app.handleWakeCommand(
    identity,
    { kind: "wake", action: "tz", tz: "Asia/Shanghai" },
    "telegram",
    "session_123",
  );
  assert.equal(tzResp, "Default timezone set to Asia/Shanghai.");
  assert.equal(fakeStore.getDefaultTimezone("alice"), "Asia/Shanghai");

  // 3. Add daily schedule (uses user default timezone)
  const addDaily = app.handleWakeCommand(
    identity,
    {
      kind: "wake",
      action: "add",
      recurrence: { kind: "daily" },
      timeOfDay: "08:30",
      prompt: "Good morning Alice",
    },
    "telegram",
    "session_123",
  );
  assert.match(addDaily, /Created wake schedule sched_001/u);
  assert.match(addDaily, /daily 08:30 \(Asia\/Shanghai\)/u);

  const addedDaily = fakeStore.get("sched_001");
  assert.ok(addedDaily);
  assert.equal(addedDaily.timezone, "Asia/Shanghai");
  assert.equal(addedDaily.sessionId, "session_123");
  assert.equal(addedDaily.channel, "telegram");
  assert.equal(addedDaily.ownerId, "alice");

  // 4. Add weekly schedule with explicit --tz
  const addWeekly = app.handleWakeCommand(
    identity,
    {
      kind: "wake",
      action: "add",
      recurrence: { kind: "weekly", weekdays: [1, 3, 5] },
      timeOfDay: "09:00",
      tz: "America/New_York",
      prompt: "Standup meeting",
    },
    "telegram",
    "session_123",
  );
  assert.match(addWeekly, /Created wake schedule sched_002/u);
  assert.match(addWeekly, /weekly mon,wed,fri 09:00 \(America\/New_York\)/u);

  const addedWeekly = fakeStore.get("sched_002");
  assert.ok(addedWeekly);
  assert.equal(addedWeekly.timezone, "America/New_York");

  // 5. List schedules
  const listResp = app.handleWakeCommand(
    identity,
    { kind: "wake", action: "list" },
    "telegram",
    "session_123",
  );
  assert.match(listResp, /\[sched_001\] \(enabled\)/u);
  assert.match(listResp, /\[sched_002\] \(enabled\)/u);

  // 6. Pause schedule
  const pauseResp = app.handleWakeCommand(
    identity,
    { kind: "wake", action: "pause", id: "sched_001" },
    "telegram",
    "session_123",
  );
  assert.equal(pauseResp, "Paused schedule sched_001.");
  assert.equal(fakeStore.get("sched_001")?.enabled, false);

  // 7. Resume schedule
  const resumeResp = app.handleWakeCommand(
    identity,
    { kind: "wake", action: "resume", id: "sched_001" },
    "telegram",
    "session_123",
  );
  assert.equal(resumeResp, "Resumed schedule sched_001.");
  assert.equal(fakeStore.get("sched_001")?.enabled, true);

  // 8. Delete schedule
  const delResp = app.handleWakeCommand(
    identity,
    { kind: "wake", action: "del", id: "sched_001" },
    "telegram",
    "session_123",
  );
  assert.equal(delResp, "Deleted schedule sched_001.");
  assert.equal(fakeStore.get("sched_001"), null);

  // 9. Delete non-existent schedule
  const delNotFound = app.handleWakeCommand(
    identity,
    { kind: "wake", action: "del", id: "non_existent" },
    "telegram",
    "session_123",
  );
  assert.equal(delNotFound, "Schedule non_existent not found.");

  // 10. File error handling in list
  fakeStore.fileError = "JSON syntax error at byte 42";
  const fileErrList = app.handleWakeCommand(
    identity,
    { kind: "wake", action: "list" },
    "telegram",
    "session_123",
  );
  assert.match(fileErrList, /Failed to read schedules: JSON syntax error/u);
  assert.match(fileErrList, /Please check schedules\.json/u);
});
