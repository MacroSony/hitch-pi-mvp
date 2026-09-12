import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WakeStore } from "../src/wake/store.js";
import type { WakeSchedule } from "../src/wake/types.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "hitch-wake-store-test-"));
}

test("lazy creation: non-existent file is healthy empty store and first add creates file", () => {
  const dir = createTempDir();
  try {
    const filePath = join(dir, "wake.json");
    const store = new WakeStore(filePath);

    assert.equal(store.fileError, null);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get("wk_12345678"), undefined);
    assert.equal(store.getDefaultTimezone("alice"), undefined);

    // First mutation creates file
    const created = store.add({
      ownerId: "alice",
      channel: "telegram",
      endpointId: "ep_1",
      sessionId: "sess_1",
      promptTemplate: "Morning prompt",
      recurrence: { kind: "daily" },
      timeOfDay: "08:30",
      timezone: "America/Toronto",
      enabled: true,
      maxFires: null,
      until: null,
    });

    assert.match(created.id, /^wk_[0-9a-z]{8}$/);
    assert.equal(created.fireCount, 0);
    assert.equal(created.lastFiredAt, null);
    assert.ok(created.createdAt.length > 0);

    // Verify file written to disk
    const diskContent = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(diskContent.version, 1);
    assert.deepEqual(diskContent.userDefaults, {});
    assert.equal(diskContent.schedules.length, 1);
    assert.equal(diskContent.schedules[0].id, created.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic write and reload roundtrip across multiple store instances", () => {
  const dir = createTempDir();
  try {
    const filePath = join(dir, "wake.json");
    const store1 = new WakeStore(filePath);

    store1.setDefaultTimezone("alice", "America/Toronto");
    store1.setDefaultTimezone("bob", "Asia/Shanghai");

    const s1 = store1.add({
      ownerId: "alice",
      channel: "telegram",
      endpointId: "ep_alice",
      sessionId: "sess_alice",
      promptTemplate: "Alice wake",
      recurrence: { kind: "weekly", weekdays: [1, 3, 5] },
      timeOfDay: "09:00",
      timezone: "America/Toronto",
      enabled: true,
      maxFires: 10,
      until: "2026-12-31",
    });

    const s2 = store1.add({
      ownerId: "bob",
      channel: "wechat",
      endpointId: "ep_bob",
      sessionId: "sess_bob",
      promptTemplate: "Bob wake",
      recurrence: { kind: "once", date: "2026-08-01" },
      timeOfDay: "10:00",
      timezone: "Asia/Shanghai",
      enabled: false,
      maxFires: 1,
      until: null,
    });

    // Reopen with new WakeStore instance
    const store2 = new WakeStore(filePath);
    assert.equal(store2.fileError, null);
    assert.equal(store2.getDefaultTimezone("alice"), "America/Toronto");
    assert.equal(store2.getDefaultTimezone("bob"), "Asia/Shanghai");
    assert.equal(store2.getDefaultTimezone("charlie"), undefined);

    const allSchedules = store2.list();
    assert.equal(allSchedules.length, 2);

    const aliceSchedules = store2.list("alice");
    assert.equal(aliceSchedules.length, 1);
    assert.deepEqual(aliceSchedules[0], s1);

    const bobSchedules = store2.list("bob");
    assert.equal(bobSchedules.length, 1);
    assert.deepEqual(bobSchedules[0], s2);

    assert.deepEqual(store2.get(s1.id), s1);
    assert.deepEqual(store2.get(s2.id), s2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutations: remove, setEnabled, recordFire", () => {
  const dir = createTempDir();
  try {
    const filePath = join(dir, "wake.json");
    const store = new WakeStore(filePath);

    const schedule = store.add({
      ownerId: "alice",
      channel: "telegram",
      endpointId: "ep_1",
      sessionId: "sess_1",
      promptTemplate: "Wake up",
      recurrence: { kind: "daily" },
      timeOfDay: "07:00",
      timezone: "UTC",
      enabled: true,
      maxFires: null,
      until: null,
    });

    // setEnabled
    assert.equal(store.setEnabled(schedule.id, false), true);
    assert.equal(store.get(schedule.id)?.enabled, false);
    assert.equal(store.setEnabled("wk_unknown", false), false);

    // recordFire
    const firedIso = "2026-04-01T07:00:00.000Z";
    store.recordFire(schedule.id, firedIso);
    let updated = store.get(schedule.id);
    assert.equal(updated?.fireCount, 1);
    assert.equal(updated?.lastFiredAt, firedIso);

    // recordFire second time
    const firedIso2 = "2026-04-02T07:00:00.000Z";
    store.recordFire(schedule.id, firedIso2);
    updated = store.get(schedule.id);
    assert.equal(updated?.fireCount, 2);
    assert.equal(updated?.lastFiredAt, firedIso2);

    // recordFire on unknown throws
    assert.throws(() => store.recordFire("wk_unknown", firedIso2));

    // remove
    assert.equal(store.remove(schedule.id), true);
    assert.equal(store.get(schedule.id), undefined);
    assert.equal(store.list().length, 0);
    assert.equal(store.remove(schedule.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external hand-edits are detected by reloadIfChanged", () => {
  const dir = createTempDir();
  try {
    const filePath = join(dir, "wake.json");
    const store = new WakeStore(filePath);

    store.add({
      ownerId: "alice",
      channel: "telegram",
      endpointId: "ep_1",
      sessionId: "sess_1",
      promptTemplate: "Prompt 1",
      recurrence: { kind: "daily" },
      timeOfDay: "09:00",
      timezone: "America/Toronto",
      enabled: true,
      maxFires: null,
      until: null,
    });

    assert.equal(store.list().length, 1);

    // Operator edits file externally by adding another schedule
    const diskData = JSON.parse(readFileSync(filePath, "utf8"));
    const manualSchedule: WakeSchedule = {
      id: "wk_hand0001",
      ownerId: "bob",
      channel: "wechat",
      endpointId: "ep_2",
      sessionId: "sess_2",
      promptTemplate: "Hand edited prompt",
      recurrence: { kind: "weekly", weekdays: [0, 6] },
      timeOfDay: "18:00",
      timezone: "UTC",
      enabled: true,
      maxFires: 5,
      until: "2026-10-31",
      fireCount: 1,
      lastFiredAt: "2026-05-01T18:00:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z",
    };
    diskData.schedules.push(manualSchedule);
    diskData.userDefaults["bob"] = { timezone: "UTC" };

    writeFileSync(filePath, JSON.stringify(diskData, null, 2) + "\n", "utf8");

    // Calling store methods without explicit reload must observe external change
    assert.equal(store.list().length, 2);
    assert.deepEqual(store.get("wk_hand0001"), manualSchedule);
    assert.equal(store.getDefaultTimezone("bob"), "UTC");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted JSON fails closed: fileError set, list/get empty, mutations reject without overwriting bad file", () => {
  const dir = createTempDir();
  try {
    const filePath = join(dir, "wake.json");
    const store = new WakeStore(filePath);

    store.add({
      ownerId: "alice",
      channel: "telegram",
      endpointId: "ep_1",
      sessionId: "sess_1",
      promptTemplate: "Original",
      recurrence: { kind: "daily" },
      timeOfDay: "09:00",
      timezone: "America/Toronto",
      enabled: true,
      maxFires: null,
      until: null,
    });

    // Corrupt the file with invalid JSON syntax
    const corruptedContent = '{"version": 1, "schedules": [ { "id": "wk_123';
    writeFileSync(filePath, corruptedContent, "utf8");

    // Re-check store
    assert.notEqual(store.fileError, null);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get("wk_abc"), undefined);
    assert.equal(store.getDefaultTimezone("alice"), undefined);

    // All mutating methods must throw and refuse to overwrite
    assert.throws(
      () =>
        store.add({
          ownerId: "bob",
          channel: "telegram",
          endpointId: "ep_2",
          sessionId: "sess_2",
          promptTemplate: "New",
          recurrence: { kind: "daily" },
          timeOfDay: "10:00",
          timezone: "UTC",
          enabled: true,
          maxFires: null,
          until: null,
        }),
      /corrupted/,
    );
    assert.throws(() => store.remove("wk_123"), /corrupted/);
    assert.throws(() => store.setEnabled("wk_123", true), /corrupted/);
    assert.throws(
      () => store.recordFire("wk_123", "2026-01-01T00:00:00.000Z"),
      /corrupted/,
    );
    assert.throws(
      () => store.setDefaultTimezone("alice", "America/Toronto"),
      /corrupted/,
    );

    // The corrupted file on disk was NOT overwritten!
    const diskContent = readFileSync(filePath, "utf8");
    assert.equal(diskContent, corruptedContent);

    // Operator fixes the file -> store recovers
    const validData = {
      version: 1,
      userDefaults: { alice: { timezone: "America/Toronto" } },
      schedules: [],
    };
    writeFileSync(filePath, JSON.stringify(validData, null, 2) + "\n", "utf8");

    assert.equal(store.fileError, null);
    assert.equal(store.getDefaultTimezone("alice"), "America/Toronto");
    const added = store.add({
      ownerId: "alice",
      channel: "telegram",
      endpointId: "ep_1",
      sessionId: "sess_1",
      promptTemplate: "Recovered",
      recurrence: { kind: "daily" },
      timeOfDay: "09:00",
      timezone: "America/Toronto",
      enabled: true,
      maxFires: null,
      until: null,
    });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.id, added.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict file validation rejects invalid schemas and fields fail-closed", () => {
  const dir = createTempDir();
  try {
    const filePath = join(dir, "wake.json");
    const store = new WakeStore(filePath);

    const validTemplate = {
      version: 1,
      userDefaults: {},
      schedules: [
        {
          id: "wk_12345678",
          ownerId: "alice",
          channel: "telegram",
          endpointId: "ep_1",
          sessionId: "sess_1",
          promptTemplate: "Valid template",
          recurrence: { kind: "daily" },
          timeOfDay: "12:00",
          timezone: "America/Toronto",
          enabled: true,
          maxFires: null,
          until: null,
          fireCount: 0,
          lastFiredAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    const invalidCases: Array<{
      name: string;
      mutate: (raw: Record<string, unknown>) => void;
    }> = [
      {
        name: "invalid version",
        mutate: (raw) => {
          raw.version = 2;
        },
      },
      {
        name: "unknown top-level field",
        mutate: (raw) => {
          raw.extraField = "hello";
        },
      },
      {
        name: "invalid timezone in userDefaults",
        mutate: (raw) => {
          raw.userDefaults = { alice: { timezone: "Mars/Olympus" } };
        },
      },
      {
        name: "duplicate schedule IDs",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules.push({ ...schedules[0] });
        },
      },
      {
        name: "invalid ID format (too short)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.id = "wk_short";
        },
      },
      {
        name: "invalid ID format (uppercase chars)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.id = "wk_ABC12345";
        },
      },
      {
        name: "invalid timeOfDay (out of 24h range)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.timeOfDay = "25:00";
        },
      },
      {
        name: "invalid timeOfDay (invalid minutes)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.timeOfDay = "12:60";
        },
      },
      {
        name: "invalid weekly recurrence (unsorted weekdays)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.recurrence = { kind: "weekly", weekdays: [3, 1] };
        },
      },
      {
        name: "invalid weekly recurrence (duplicate weekdays)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.recurrence = { kind: "weekly", weekdays: [1, 1] };
        },
      },
      {
        name: "invalid weekly recurrence (empty weekdays)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.recurrence = { kind: "weekly", weekdays: [] };
        },
      },
      {
        name: "invalid weekly recurrence (weekday out of range 0..6)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.recurrence = { kind: "weekly", weekdays: [7] };
        },
      },
      {
        name: "invalid once recurrence (leap day on non-leap year)",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.recurrence = { kind: "once", date: "2026-02-29" };
        },
      },
      {
        name: "invalid channel",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.channel = "slack";
        },
      },
      {
        name: "invalid until date",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.until = "not-a-date";
        },
      },
      {
        name: "unknown field inside schedule",
        mutate: (raw) => {
          const schedules = raw.schedules as Array<Record<string, unknown>>;
          schedules[0]!.unknownProp = 123;
        },
      },
    ];

    for (const testCase of invalidCases) {
      const raw = structuredClone(validTemplate);
      testCase.mutate(raw);
      const json = JSON.stringify(raw, null, 2) + "\n";
      writeFileSync(filePath, json, "utf8");

      assert.notEqual(
        store.fileError,
        null,
        `Expected fileError for case: ${testCase.name}`,
      );
      assert.deepEqual(store.list(), []);
      assert.throws(() => store.remove("wk_12345678"), /corrupted/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
