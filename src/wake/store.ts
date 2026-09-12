import { randomInt, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { WakeRecurrence, WakeSchedule } from "./types.js";

interface UserDefaultsRecord {
  timezone: string;
}

interface WakeStoreFile {
  version: 1;
  userDefaults: Record<string, UserDefaultsRecord>;
  schedules: WakeSchedule[];
}

function isValidIanaTimezone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function isValidDateString(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = date.split("-");
  if (yearStr === undefined || monthStr === undefined || dayStr === undefined) {
    return false;
  }
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function isValidIsoDate(iso: unknown): iso is string {
  if (typeof iso !== "string" || iso.trim().length === 0) {
    return false;
  }
  const timestamp = Date.parse(iso);
  return !Number.isNaN(timestamp);
}

function isValidRecurrence(rec: unknown): rec is WakeRecurrence {
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
    return false;
  }
  const obj = rec as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === "once") {
    const keys = Object.keys(obj);
    if (keys.length !== 2) return false;
    return isValidDateString(obj.date);
  }
  if (kind === "daily") {
    const keys = Object.keys(obj);
    return keys.length === 1;
  }
  if (kind === "weekly") {
    const keys = Object.keys(obj);
    if (keys.length !== 2) return false;
    const weekdays = obj.weekdays;
    if (
      !Array.isArray(weekdays) ||
      weekdays.length === 0 ||
      weekdays.length > 7
    ) {
      return false;
    }
    for (let i = 0; i < weekdays.length; i += 1) {
      const w = weekdays[i];
      if (typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 6) {
        return false;
      }
      if (i > 0 && w <= (weekdays[i - 1] as number)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

type ValidationResult =
  | { ok: true; data: WakeStoreFile }
  | { ok: false; error: string };

const SCHEDULE_ALLOWED_KEYS = new Set([
  "id",
  "ownerId",
  "channel",
  "endpointId",
  "sessionId",
  "promptTemplate",
  "recurrence",
  "timeOfDay",
  "timezone",
  "enabled",
  "maxFires",
  "until",
  "fireCount",
  "lastFiredAt",
  "createdAt",
]);

function validateStoreData(data: unknown): ValidationResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "Root must be an object" };
  }
  const root = data as Record<string, unknown>;
  const rootKeys = Object.keys(root);
  const allowedRootKeys = new Set(["version", "userDefaults", "schedules"]);
  for (const k of rootKeys) {
    if (!allowedRootKeys.has(k)) {
      return { ok: false, error: `Unknown top-level field: ${k}` };
    }
  }

  if (root.version !== 1) {
    return { ok: false, error: "Invalid version: must be 1" };
  }

  if (
    typeof root.userDefaults !== "object" ||
    root.userDefaults === null ||
    Array.isArray(root.userDefaults)
  ) {
    return { ok: false, error: "userDefaults must be an object" };
  }
  const userDefaultsRaw = root.userDefaults as Record<string, unknown>;
  const userDefaults: Record<string, UserDefaultsRecord> = {};
  for (const [ownerId, def] of Object.entries(userDefaultsRaw)) {
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      return { ok: false, error: "Invalid ownerId in userDefaults" };
    }
    if (typeof def !== "object" || def === null || Array.isArray(def)) {
      return { ok: false, error: `userDefaults[${ownerId}] must be an object` };
    }
    const defKeys = Object.keys(def);
    if (defKeys.length !== 1 || defKeys[0] !== "timezone") {
      return {
        ok: false,
        error: `userDefaults[${ownerId}] must contain only timezone`,
      };
    }
    const tz = (def as { timezone?: unknown }).timezone;
    if (!isValidIanaTimezone(tz)) {
      return {
        ok: false,
        error: `Invalid IANA timezone for owner ${ownerId}: ${String(tz)}`,
      };
    }
    userDefaults[ownerId] = { timezone: tz };
  }

  if (!Array.isArray(root.schedules)) {
    return { ok: false, error: "schedules must be an array" };
  }

  const seenIds = new Set<string>();
  const schedules: WakeSchedule[] = [];
  for (const s of root.schedules) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      return { ok: false, error: "Schedule item must be an object" };
    }
    const scheduleObj = s as Record<string, unknown>;
    const sKeys = Object.keys(scheduleObj);
    for (const k of sKeys) {
      if (!SCHEDULE_ALLOWED_KEYS.has(k)) {
        return { ok: false, error: `Unknown field in schedule: ${k}` };
      }
    }
    for (const reqKey of SCHEDULE_ALLOWED_KEYS) {
      if (!(reqKey in scheduleObj)) {
        return {
          ok: false,
          error: `Missing required field in schedule: ${reqKey}`,
        };
      }
    }

    const id = scheduleObj.id;
    if (typeof id !== "string" || !/^wk_[0-9a-z]{8}$/.test(id)) {
      return { ok: false, error: `Invalid schedule id format: ${String(id)}` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `Duplicate schedule id: ${id}` };
    }
    seenIds.add(id);

    const ownerId = scheduleObj.ownerId;
    if (typeof ownerId !== "string" || ownerId.length === 0) {
      return {
        ok: false,
        error: "Schedule ownerId must be a non-empty string",
      };
    }

    const channel = scheduleObj.channel;
    if (channel !== "telegram" && channel !== "wechat") {
      return {
        ok: false,
        error: `Invalid schedule channel: ${String(channel)}`,
      };
    }

    const endpointId = scheduleObj.endpointId;
    if (typeof endpointId !== "string" || endpointId.length === 0) {
      return {
        ok: false,
        error: "Schedule endpointId must be a non-empty string",
      };
    }

    const sessionId = scheduleObj.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return {
        ok: false,
        error: "Schedule sessionId must be a non-empty string",
      };
    }

    const promptTemplate = scheduleObj.promptTemplate;
    if (typeof promptTemplate !== "string") {
      return { ok: false, error: "Schedule promptTemplate must be a string" };
    }

    if (!isValidRecurrence(scheduleObj.recurrence)) {
      return { ok: false, error: "Invalid schedule recurrence" };
    }

    const timeOfDay = scheduleObj.timeOfDay;
    if (
      typeof timeOfDay !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)
    ) {
      return {
        ok: false,
        error: `Invalid schedule timeOfDay: ${String(timeOfDay)}`,
      };
    }

    const timezone = scheduleObj.timezone;
    if (!isValidIanaTimezone(timezone)) {
      return {
        ok: false,
        error: `Invalid schedule timezone: ${String(timezone)}`,
      };
    }

    const enabled = scheduleObj.enabled;
    if (typeof enabled !== "boolean") {
      return { ok: false, error: "Schedule enabled must be a boolean" };
    }

    const maxFires = scheduleObj.maxFires;
    if (
      maxFires !== null &&
      (typeof maxFires !== "number" ||
        !Number.isSafeInteger(maxFires) ||
        maxFires < 1)
    ) {
      return {
        ok: false,
        error: "Schedule maxFires must be null or an integer >= 1",
      };
    }

    const until = scheduleObj.until;
    if (until !== null && !isValidDateString(until)) {
      return {
        ok: false,
        error: "Schedule until must be null or a valid YYYY-MM-DD date string",
      };
    }

    const fireCount = scheduleObj.fireCount;
    if (
      typeof fireCount !== "number" ||
      !Number.isSafeInteger(fireCount) ||
      fireCount < 0
    ) {
      return {
        ok: false,
        error: "Schedule fireCount must be a non-negative integer",
      };
    }

    const lastFiredAt = scheduleObj.lastFiredAt;
    if (lastFiredAt !== null && !isValidIsoDate(lastFiredAt)) {
      return {
        ok: false,
        error: "Schedule lastFiredAt must be null or a valid ISO date string",
      };
    }

    const createdAt = scheduleObj.createdAt;
    if (!isValidIsoDate(createdAt)) {
      return {
        ok: false,
        error: "Schedule createdAt must be a valid ISO date string",
      };
    }

    schedules.push({
      id,
      ownerId,
      channel,
      endpointId,
      sessionId,
      promptTemplate,
      recurrence: scheduleObj.recurrence as WakeRecurrence,
      timeOfDay,
      timezone,
      enabled,
      maxFires,
      until,
      fireCount,
      lastFiredAt,
      createdAt,
    });
  }

  return {
    ok: true,
    data: {
      version: 1,
      userDefaults,
      schedules,
    },
  };
}

function generateWakeId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let i = 0; i < 8; i += 1) {
    suffix += chars[randomInt(chars.length)];
  }
  return `wk_${suffix}`;
}

export class WakeStore {
  readonly #filePath: string;
  #fileError: string | null = null;
  #lastMtimeMs = -1;
  #lastSize = -1;
  #userDefaults: Record<string, UserDefaultsRecord> = {};
  #schedules: WakeSchedule[] = [];

  public constructor(filePath: string) {
    this.#filePath = resolve(filePath);
    this.reloadIfChanged();
  }

  public get fileError(): string | null {
    this.reloadIfChanged();
    return this.#fileError;
  }

  public reloadIfChanged(): void {
    let stat: Stats;
    try {
      stat = statSync(this.#filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#fileError = null;
        this.#lastMtimeMs = -1;
        this.#lastSize = -1;
        this.#userDefaults = {};
        this.#schedules = [];
        return;
      }
      this.#fileError = `Cannot stat store file: ${String(error)}`;
      this.#userDefaults = {};
      this.#schedules = [];
      return;
    }

    if (
      this.#lastMtimeMs !== -1 &&
      stat.mtimeMs === this.#lastMtimeMs &&
      stat.size === this.#lastSize
    ) {
      return;
    }

    let content: string;
    try {
      content = readFileSync(this.#filePath, "utf8");
    } catch (error: unknown) {
      this.#fileError = `Cannot read store file: ${String(error)}`;
      this.#lastMtimeMs = stat.mtimeMs;
      this.#lastSize = stat.size;
      this.#userDefaults = {};
      this.#schedules = [];
      return;
    }

    this.#lastMtimeMs = stat.mtimeMs;
    this.#lastSize = stat.size;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      this.#fileError = `Invalid JSON in store file: ${String(error)}`;
      this.#userDefaults = {};
      this.#schedules = [];
      return;
    }

    const validationResult = validateStoreData(parsed);
    if (!validationResult.ok) {
      this.#fileError = validationResult.error;
      this.#userDefaults = {};
      this.#schedules = [];
      return;
    }

    this.#fileError = null;
    this.#userDefaults = validationResult.data.userDefaults;
    this.#schedules = validationResult.data.schedules;
  }

  #assertHealthy(): void {
    if (this.#fileError !== null) {
      throw new Error(`WakeStore file is corrupted: ${this.#fileError}`);
    }
  }

  #writeToDisk(): void {
    const dir = dirname(this.#filePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(
      dir,
      `.${basename(this.#filePath)}.${randomUUID()}.tmp`,
    );
    const data: WakeStoreFile = {
      version: 1,
      userDefaults: this.#userDefaults,
      schedules: this.#schedules,
    };
    const json = JSON.stringify(data, null, 2) + "\n";
    writeFileSync(tmpPath, json, "utf8");
    renameSync(tmpPath, this.#filePath);
    const stat = statSync(this.#filePath);
    this.#lastMtimeMs = stat.mtimeMs;
    this.#lastSize = stat.size;
    this.#fileError = null;
  }

  public list(ownerId?: string): WakeSchedule[] {
    this.reloadIfChanged();
    if (this.#fileError !== null) {
      return [];
    }
    return this.#schedules
      .filter((s) => ownerId === undefined || s.ownerId === ownerId)
      .map((s) => structuredClone(s));
  }

  public get(id: string): WakeSchedule | undefined {
    this.reloadIfChanged();
    if (this.#fileError !== null) {
      return undefined;
    }
    const schedule = this.#schedules.find((s) => s.id === id);
    return schedule === undefined ? undefined : structuredClone(schedule);
  }

  public add(
    input: Omit<WakeSchedule, "id" | "fireCount" | "lastFiredAt" | "createdAt">,
  ): WakeSchedule {
    this.reloadIfChanged();
    this.#assertHealthy();

    if (typeof input.ownerId !== "string" || input.ownerId.length === 0) {
      throw new Error("Invalid ownerId");
    }
    if (input.channel !== "telegram" && input.channel !== "wechat") {
      throw new Error(`Invalid channel: ${String(input.channel)}`);
    }
    if (typeof input.endpointId !== "string" || input.endpointId.length === 0) {
      throw new Error("Invalid endpointId");
    }
    if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
      throw new Error("Invalid sessionId");
    }
    if (typeof input.promptTemplate !== "string") {
      throw new Error("Invalid promptTemplate");
    }
    if (!isValidRecurrence(input.recurrence)) {
      throw new Error("Invalid recurrence");
    }
    if (
      typeof input.timeOfDay !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.timeOfDay)
    ) {
      throw new Error(`Invalid timeOfDay: ${String(input.timeOfDay)}`);
    }
    if (!isValidIanaTimezone(input.timezone)) {
      throw new Error(`Invalid timezone: ${String(input.timezone)}`);
    }
    if (typeof input.enabled !== "boolean") {
      throw new Error("Invalid enabled flag");
    }
    if (
      input.maxFires !== null &&
      (typeof input.maxFires !== "number" ||
        !Number.isSafeInteger(input.maxFires) ||
        input.maxFires < 1)
    ) {
      throw new Error("Invalid maxFires: must be null or integer >= 1");
    }
    if (input.until !== null && !isValidDateString(input.until)) {
      throw new Error("Invalid until: must be null or valid YYYY-MM-DD");
    }

    let id = generateWakeId();
    while (this.#schedules.some((s) => s.id === id)) {
      id = generateWakeId();
    }

    const createdAt = new Date().toISOString();
    const newSchedule: WakeSchedule = {
      id,
      ownerId: input.ownerId,
      channel: input.channel,
      endpointId: input.endpointId,
      sessionId: input.sessionId,
      promptTemplate: input.promptTemplate,
      recurrence: structuredClone(input.recurrence),
      timeOfDay: input.timeOfDay,
      timezone: input.timezone,
      enabled: input.enabled,
      maxFires: input.maxFires,
      until: input.until,
      fireCount: 0,
      lastFiredAt: null,
      createdAt,
    };

    this.#schedules.push(newSchedule);
    this.#writeToDisk();
    return structuredClone(newSchedule);
  }

  public remove(id: string): boolean {
    this.reloadIfChanged();
    this.#assertHealthy();

    const index = this.#schedules.findIndex((s) => s.id === id);
    if (index === -1) {
      return false;
    }
    this.#schedules.splice(index, 1);
    this.#writeToDisk();
    return true;
  }

  public setEnabled(id: string, enabled: boolean): boolean {
    this.reloadIfChanged();
    this.#assertHealthy();

    const schedule = this.#schedules.find((s) => s.id === id);
    if (schedule === undefined) {
      return false;
    }
    schedule.enabled = enabled;
    this.#writeToDisk();
    return true;
  }

  public recordFire(id: string, firedAtUtcIso: string): void {
    this.reloadIfChanged();
    this.#assertHealthy();

    const schedule = this.#schedules.find((s) => s.id === id);
    if (schedule === undefined) {
      throw new Error(`Schedule not found: ${id}`);
    }
    if (!isValidIsoDate(firedAtUtcIso)) {
      throw new Error(`Invalid firedAtUtcIso: ${firedAtUtcIso}`);
    }

    schedule.fireCount += 1;
    schedule.lastFiredAt = firedAtUtcIso;
    this.#writeToDisk();
  }

  public recordSkip(id: string, skippedSlotUtcIso: string): void {
    this.reloadIfChanged();
    this.#assertHealthy();

    const schedule = this.#schedules.find((s) => s.id === id);
    if (schedule === undefined) {
      throw new Error(`Schedule not found: ${id}`);
    }
    if (!isValidIsoDate(skippedSlotUtcIso)) {
      throw new Error(`Invalid skippedSlotUtcIso: ${skippedSlotUtcIso}`);
    }

    schedule.lastFiredAt = skippedSlotUtcIso;
    this.#writeToDisk();
  }

  public getDefaultTimezone(ownerId: string): string | undefined {
    this.reloadIfChanged();
    if (this.#fileError !== null) {
      return undefined;
    }
    return this.#userDefaults[ownerId]?.timezone;
  }

  public setDefaultTimezone(ownerId: string, timezone: string): void {
    this.reloadIfChanged();
    this.#assertHealthy();

    if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
      throw new Error("Invalid ownerId");
    }
    if (!isValidIanaTimezone(timezone)) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }

    this.#userDefaults[ownerId] = { timezone };
    this.#writeToDisk();
  }
}
