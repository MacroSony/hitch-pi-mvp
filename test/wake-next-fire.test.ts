import assert from "node:assert/strict";
import test from "node:test";

import { nextFireAfter } from "../src/wake/next-fire.js";
import type { WakeSchedule } from "../src/wake/types.js";

function baseSchedule(overrides: Partial<WakeSchedule> = {}): WakeSchedule {
  return {
    id: "wk_abc12345",
    ownerId: "alice",
    channel: "telegram",
    endpointId: "ep_1",
    sessionId: "sess_1",
    promptTemplate: "Good morning!",
    recurrence: { kind: "daily" },
    timeOfDay: "09:00",
    timezone: "America/Toronto",
    enabled: true,
    maxFires: null,
    until: null,
    fireCount: 0,
    lastFiredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("America/Toronto 2026 spring DST jump: 02:30 does not exist on March 8 and shifts to next valid moment", () => {
  const schedule = baseSchedule({
    timeOfDay: "02:30",
    timezone: "America/Toronto",
    recurrence: { kind: "daily" },
  });

  // 2026-03-08 00:00 UTC (which is 2026-03-07 19:00 EST)
  const afterUtcMs = Date.parse("2026-03-08T00:00:00.000Z");
  const fire1 = nextFireAfter(schedule, afterUtcMs);
  assert.notEqual(fire1, null);
  // On 2026-03-08, clocks jump from 02:00 EST (07:00 UTC) to 03:00 EDT (07:00 UTC).
  // 02:30 is skipped, so next valid moment is 07:00:00 UTC (03:00 EDT).
  assert.equal(new Date(fire1!).toISOString(), "2026-03-08T07:00:00.000Z");

  // Advance to next day from fire1
  const fire2 = nextFireAfter(schedule, fire1!);
  assert.notEqual(fire2, null);
  // On 2026-03-09, EDT offset is UTC-4, so 02:30 EDT is 06:30:00 UTC
  assert.equal(new Date(fire2!).toISOString(), "2026-03-09T06:30:00.000Z");
});

test("America/Toronto 2026 fall DST overlap: 01:30 occurs twice on November 1 and takes first occurrence", () => {
  const schedule = baseSchedule({
    timeOfDay: "01:30",
    timezone: "America/Toronto",
    recurrence: { kind: "daily" },
  });

  // Start before Nov 1
  const afterUtcMs = Date.parse("2026-11-01T00:00:00.000Z");
  const fire1 = nextFireAfter(schedule, afterUtcMs);
  assert.notEqual(fire1, null);
  // Nov 1 01:30 EDT is UTC-4 -> 05:30:00 UTC
  // Nov 1 01:30 EST is UTC-5 -> 06:30:00 UTC
  // Taking the first occurrence gives 05:30:00 UTC
  assert.equal(new Date(fire1!).toISOString(), "2026-11-01T05:30:00.000Z");

  // Advance from fire1 -> next daily fire on Nov 2
  const fire2 = nextFireAfter(schedule, fire1!);
  assert.notEqual(fire2, null);
  // On Nov 2, standard time EST (UTC-5), 01:30 EST is 06:30:00 UTC
  assert.equal(new Date(fire2!).toISOString(), "2026-11-02T06:30:00.000Z");
});

test("daily schedule regular progression across multiple days and timezones", () => {
  const schedule = baseSchedule({
    timeOfDay: "14:30",
    timezone: "Asia/Shanghai", // UTC+8
    recurrence: { kind: "daily" },
  });

  // 2026-06-01 05:00 UTC is 13:00 in Shanghai (before 14:30)
  const after1 = Date.parse("2026-06-01T05:00:00.000Z");
  const fire1 = nextFireAfter(schedule, after1);
  assert.notEqual(fire1, null);
  // 14:30 in Shanghai is 06:30 UTC
  assert.equal(new Date(fire1!).toISOString(), "2026-06-01T06:30:00.000Z");

  // Exactly at fire1: next must be strictly greater than afterUtcMs
  const fire2 = nextFireAfter(schedule, fire1!);
  assert.notEqual(fire2, null);
  assert.equal(new Date(fire2!).toISOString(), "2026-06-02T06:30:00.000Z");

  // Advance to third day
  const fire3 = nextFireAfter(schedule, fire2!);
  assert.notEqual(fire3, null);
  assert.equal(new Date(fire3!).toISOString(), "2026-06-03T06:30:00.000Z");
});

test("weekly schedule progression, multiple days, and crossing weekend", () => {
  // Mon (1), Wed (3), Fri (5) at 10:00 in America/New_York
  const schedule = baseSchedule({
    timeOfDay: "10:00",
    timezone: "America/New_York",
    recurrence: { kind: "weekly", weekdays: [1, 3, 5] },
  });

  // 2026-06-01 is Monday. 10:00 EDT is 14:00 UTC.
  // Query at Monday 08:00 EDT (12:00 UTC)
  const mondayMorning = Date.parse("2026-06-01T12:00:00.000Z");
  const fireMonday = nextFireAfter(schedule, mondayMorning);
  assert.notEqual(fireMonday, null);
  assert.equal(new Date(fireMonday!).toISOString(), "2026-06-01T14:00:00.000Z");

  // Query after Monday fire -> Wednesday 10:00 EDT (14:00 UTC on June 3)
  const fireWed = nextFireAfter(schedule, fireMonday!);
  assert.notEqual(fireWed, null);
  assert.equal(new Date(fireWed!).toISOString(), "2026-06-03T14:00:00.000Z");

  // Query after Wednesday fire -> Friday 10:00 EDT (14:00 UTC on June 5)
  const fireFri = nextFireAfter(schedule, fireWed!);
  assert.notEqual(fireFri, null);
  assert.equal(new Date(fireFri!).toISOString(), "2026-06-05T14:00:00.000Z");

  // Query after Friday fire -> Weekend crossed! Next is Monday June 8 10:00 EDT (14:00 UTC)
  const fireNextMon = nextFireAfter(schedule, fireFri!);
  assert.notEqual(fireNextMon, null);
  assert.equal(
    new Date(fireNextMon!).toISOString(),
    "2026-06-08T14:00:00.000Z",
  );
});

test("weekly schedule on weekends (Sunday=0, Saturday=6)", () => {
  const schedule = baseSchedule({
    timeOfDay: "18:00",
    timezone: "UTC",
    recurrence: { kind: "weekly", weekdays: [0, 6] },
  });

  // 2026-06-05 is Friday. Next is Saturday June 6
  const friday = Date.parse("2026-06-05T20:00:00.000Z");
  const fireSat = nextFireAfter(schedule, friday);
  assert.notEqual(fireSat, null);
  assert.equal(new Date(fireSat!).toISOString(), "2026-06-06T18:00:00.000Z");

  // Next is Sunday June 7
  const fireSun = nextFireAfter(schedule, fireSat!);
  assert.notEqual(fireSun, null);
  assert.equal(new Date(fireSun!).toISOString(), "2026-06-07T18:00:00.000Z");

  // Next is Saturday June 13
  const fireNextSat = nextFireAfter(schedule, fireSun!);
  assert.notEqual(fireNextSat, null);
  assert.equal(
    new Date(fireNextSat!).toISOString(),
    "2026-06-13T18:00:00.000Z",
  );
});

test("once schedule returns target time when unexecuted and null after firing", () => {
  const schedule = baseSchedule({
    timeOfDay: "08:15",
    timezone: "America/Toronto",
    recurrence: { kind: "once", date: "2026-07-20" },
    lastFiredAt: null,
    fireCount: 0,
  });

  // Before target date
  const beforeMs = Date.parse("2026-07-01T00:00:00.000Z");
  const fire1 = nextFireAfter(schedule, beforeMs);
  assert.notEqual(fire1, null);
  // 2026-07-20 08:15 EDT is 12:15 UTC
  assert.equal(new Date(fire1!).toISOString(), "2026-07-20T12:15:00.000Z");

  // Even if afterUtcMs has passed the date, if it never fired (lastFiredAt === null), it still returns target time
  const afterDateMs = Date.parse("2026-07-25T00:00:00.000Z");
  const fireCatchup = nextFireAfter(schedule, afterDateMs);
  assert.equal(fireCatchup, fire1);

  // Once it has fired (lastFiredAt is recorded), returns null
  const firedSchedule = {
    ...schedule,
    fireCount: 1,
    lastFiredAt: "2026-07-20T12:15:00.000Z",
  };
  assert.equal(nextFireAfter(firedSchedule, beforeMs), null);
  assert.equal(nextFireAfter(firedSchedule, afterDateMs), null);
});

test("maxFires exhaustion returns null", () => {
  const schedule = baseSchedule({
    maxFires: 3,
    fireCount: 2,
    recurrence: { kind: "daily" },
    timeOfDay: "12:00",
    timezone: "UTC",
  });

  // fireCount = 2 < maxFires (3) -> returns next fire
  const fire = nextFireAfter(schedule, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.notEqual(fire, null);
  assert.equal(new Date(fire!).toISOString(), "2026-01-01T12:00:00.000Z");

  // fireCount = 3 >= maxFires (3) -> exhausted
  const exhausted = { ...schedule, fireCount: 3 };
  assert.equal(
    nextFireAfter(exhausted, Date.parse("2026-01-01T00:00:00.000Z")),
    null,
  );
});

test("until exhaustion boundary conditions", () => {
  const schedule = baseSchedule({
    timeOfDay: "09:00",
    timezone: "America/Toronto",
    recurrence: { kind: "daily" },
    until: "2026-05-10",
  });

  // On 2026-05-09 -> next fire is 2026-05-09 09:00 EDT (13:00 UTC)
  const fire1 = nextFireAfter(schedule, Date.parse("2026-05-09T00:00:00.000Z"));
  assert.notEqual(fire1, null);
  assert.equal(new Date(fire1!).toISOString(), "2026-05-09T13:00:00.000Z");

  // On 2026-05-09 13:00 UTC -> next fire is 2026-05-10 09:00 EDT (13:00 UTC, until day itself is included)
  const fire2 = nextFireAfter(schedule, fire1!);
  assert.notEqual(fire2, null);
  assert.equal(new Date(fire2!).toISOString(), "2026-05-10T13:00:00.000Z");

  // After 2026-05-10 fire -> next would be 2026-05-11 which exceeds until -> returns null
  const fire3 = nextFireAfter(schedule, fire2!);
  assert.equal(fire3, null);
});

test("UTC timezone trivial case", () => {
  const schedule = baseSchedule({
    timeOfDay: "00:00",
    timezone: "UTC",
    recurrence: { kind: "daily" },
  });

  // Exactly at midnight 2026-01-01 -> strictly after means 2026-01-02 00:00 UTC
  const fire1 = nextFireAfter(schedule, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.notEqual(fire1, null);
  assert.equal(new Date(fire1!).toISOString(), "2026-01-02T00:00:00.000Z");

  // At 23:59:59.999 -> next is 2026-01-02 00:00 UTC
  const fire2 = nextFireAfter(schedule, Date.parse("2026-01-01T23:59:59.999Z"));
  assert.equal(fire2, fire1);
});
