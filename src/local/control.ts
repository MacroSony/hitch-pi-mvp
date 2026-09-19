import { createHash } from "node:crypto";

import { HitchApplication } from "../app/application.js";
import { AppError } from "../app/errors.js";
import { HitchStore, type LocalEndpoint } from "../app/store.js";
import { nextFireAfter } from "../wake/next-fire.js";
import type { WakeRecurrence, WakeSchedule } from "../wake/types.js";
import {
  LocalControlError,
  type LocalCallerConfig,
  type LocalHandler,
  type LocalMethod,
} from "./types.js";

const MAX_REQUEST_ID_BYTES = 128;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_SCHEDULES_PER_USER = 64;

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(): never {
  throw new LocalControlError("rejected");
}
function forbidden(): never {
  throw new LocalControlError("forbidden");
}
function notFound(): never {
  throw new LocalControlError("not-found");
}
function conflict(): never {
  throw new LocalControlError("conflict");
}
function unavailable(): never {
  throw new LocalControlError("unavailable");
}

function stringValue(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) reject();
  if (Buffer.byteLength(value, "utf8") > maxBytes) reject();
  return value;
}

function exactKeys(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) reject();
  if (required.some((key) => !(key in value))) reject();
}

function channel(value: unknown): "wechat" | "telegram" | "wecom" | undefined {
  if (value === undefined) return undefined;
  if (value !== "wechat" && value !== "telegram" && value !== "wecom") reject();
  return value;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(method: LocalMethod, params: RecordValue): string {
  const withoutRequest = { ...params };
  delete withoutRequest.requestId;
  return createHash("sha256")
    .update(`${method}\n${stable(withoutRequest)}`)
    .digest("hex");
}

function mutationId(params: RecordValue): string {
  return stringValue(params.requestId, MAX_REQUEST_ID_BYTES);
}

function validDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

function recurrence(value: unknown): WakeRecurrence {
  if (!record(value) || typeof value.kind !== "string") reject();
  if (value.kind === "once") {
    exactKeys(value, ["kind", "date"]);
    const date = stringValue(value.date, 32);
    if (!validDateString(date)) reject();
    return { kind: "once", date };
  }
  if (value.kind === "daily") {
    exactKeys(value, ["kind"]);
    return { kind: "daily" };
  }
  if (value.kind === "weekly") {
    exactKeys(value, ["kind", "weekdays"]);
    if (
      !Array.isArray(value.weekdays) ||
      value.weekdays.length === 0 ||
      value.weekdays.length > 7
    )
      reject();
    const weekdays = value.weekdays.map((day) => {
      if (
        typeof day !== "number" ||
        !Number.isInteger(day) ||
        day < 0 ||
        day > 6
      )
        reject();
      return day;
    });
    if (
      new Set(weekdays).size !== weekdays.length ||
      weekdays.some((day, i) => i > 0 && day <= weekdays[i - 1]!)
    )
      reject();
    return { kind: "weekly", weekdays };
  }
  reject();
}

function validTimezone(value: unknown): string {
  const timezone = stringValue(value, 128);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    reject();
  }
  return timezone;
}

function safeSchedule(schedule: WakeSchedule, now: number): RecordValue {
  const next =
    schedule.enabled && schedule.cancelled !== true
      ? nextFireAfter(schedule, now)
      : null;
  return {
    scheduleId: schedule.id,
    userId: schedule.ownerId,
    action: schedule.action ?? "wake",
    textPreview: Array.from(schedule.promptTemplate).slice(0, 240).join(""),
    textTruncated: Array.from(schedule.promptTemplate).length > 240,
    channel: schedule.channel,
    endpointId: schedule.endpointId,
    sessionId: schedule.sessionId || null,
    recurrence: structuredClone(schedule.recurrence),
    timeOfDay: schedule.timeOfDay,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    cancelled: schedule.cancelled === true,
    nextFire: next === null ? null : new Date(next).toISOString(),
    lastOutcome: schedule.lastOutcome ?? null,
  };
}

function replay(result: unknown): RecordValue {
  if (!record(result)) unavailable();
  return { ...result, duplicate: true };
}

function mapError(error: unknown): never {
  if (error instanceof LocalControlError) throw error;
  if (error instanceof AppError) {
    if (error.category === "busy") throw new LocalControlError("busy");
    if (error.category === "rejected") throw new LocalControlError("rejected");
  }
  throw new LocalControlError("unavailable");
}

function endpointFor(
  store: HitchStore,
  caller: LocalCallerConfig,
  userId: string,
  requestedChannel?: "wechat" | "telegram" | "wecom",
): LocalEndpoint {
  if (!caller.userIds.includes(userId)) forbidden();
  const candidates = store.localEndpointCandidates(userId);
  const matches =
    requestedChannel === undefined
      ? candidates
      : candidates.filter(
          (candidate) => candidate.channel === requestedChannel,
        );
  if (matches.length === 0) notFound();
  if (matches.length !== 1) reject();
  const endpoint = matches[0];
  if (endpoint === undefined) notFound();
  return endpoint;
}

function ownedExternal(
  schedule: WakeSchedule | undefined,
  caller: LocalCallerConfig,
  userId: string,
): WakeSchedule {
  if (
    schedule === undefined ||
    schedule.ownerId !== userId ||
    schedule.origin?.callerId !== caller.id
  )
    notFound();
  return schedule;
}

function checkUser(caller: LocalCallerConfig, value: unknown): string {
  const userId = stringValue(value, 128);
  if (!caller.userIds.includes(userId)) forbidden();
  return userId;
}

/** Create the private, already-authenticated LOCAL-1 handler. */
export function createLocalHandler(
  store: HitchStore,
  application: HitchApplication,
): LocalHandler {
  return (caller, request) => {
    try {
      if (!caller.actions.includes(request.method)) forbidden();
      if (!record(request.params)) reject();
      const params = request.params as RecordValue;

      switch (request.method) {
        case "targets.list": {
          exactKeys(params, []);
          return { users: store.localTargets(caller.userIds) };
        }
        case "delivery.get": {
          exactKeys(params, ["userId", "deliveryId"]);
          const userId = checkUser(caller, params.userId);
          const deliveryId = stringValue(params.deliveryId, 256);
          const state = store.localDeliveryState(userId, deliveryId);
          if (state === null) notFound();
          return state;
        }
        case "notify": {
          exactKeys(params, ["userId", "text", "requestId"], ["channel"]);
          const userId = checkUser(caller, params.userId);
          const text = stringValue(params.text, MAX_TEXT_BYTES);
          const selectedChannel = channel(params.channel);
          const requestId = mutationId(params);
          const requestDigest = digest(request.method, params);
          const receipt = store.localRequest(caller.id, requestId);
          if (receipt !== null) {
            if (receipt.digest !== requestDigest) conflict();
            return replay(receipt.result);
          }
          const endpoint = endpointFor(store, caller, userId, selectedChannel);
          store.assertLocalMutationAllowed(caller.id);
          const mutation = store.localNotify(
            caller.id,
            requestId,
            requestDigest,
            userId,
            endpoint.endpoint.id,
            text,
          );
          return { ...mutation.result, duplicate: mutation.duplicate };
        }
        case "schedule.list": {
          exactKeys(params, ["userId"]);
          const userId = checkUser(caller, params.userId);
          const wakeStore = application.localWakeStore(userId);
          if (wakeStore.fileError !== null) unavailable();
          const schedules = wakeStore
            .list(userId)
            .filter((schedule) => schedule.origin?.callerId === caller.id)
            .map((schedule) => safeSchedule(schedule, store.clock.now()));
          return { schedules };
        }
        case "schedule.create": {
          exactKeys(
            params,
            [
              "requestId",
              "userId",
              "action",
              "text",
              "timeOfDay",
              "timezone",
              "recurrence",
            ],
            ["channel", "sessionId"],
          );
          const userId = checkUser(caller, params.userId);
          const action = params.action;
          if (action !== "notify" && action !== "wake") reject();
          const text = stringValue(params.text, MAX_TEXT_BYTES);
          const timeOfDay = stringValue(params.timeOfDay, 8);
          if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDay)) reject();
          const timezone = validTimezone(params.timezone);
          const rec = recurrence(params.recurrence);
          const selectedChannel = channel(params.channel);
          const requestId = mutationId(params);
          const requestDigest = digest(request.method, params);
          const existingReceipt = store.localRequest(caller.id, requestId);
          if (existingReceipt !== null) {
            if (existingReceipt.digest !== requestDigest) conflict();
            return replay(existingReceipt.result);
          }
          const wakeStore = application.localWakeStore(userId);
          if (wakeStore.fileError !== null) unavailable();
          const scheduleId = store.getLocalScheduleId(
            caller.id,
            requestId,
            requestDigest,
          );
          let recovered: WakeSchedule | undefined;
          for (const allowedUserId of caller.userIds) {
            const candidateStore =
              allowedUserId === userId
                ? wakeStore
                : application.localWakeStore(allowedUserId);
            if (candidateStore.fileError !== null) unavailable();
            for (const candidate of candidateStore.list(allowedUserId)) {
              const sameOriginKey =
                candidate.origin?.callerId === caller.id &&
                candidate.origin?.requestId === requestId;
              if (sameOriginKey) {
                if (candidate.origin?.digest !== requestDigest) conflict();
                recovered = candidate;
              }
              if (
                candidate.id === scheduleId &&
                (candidate.origin?.callerId !== caller.id ||
                  candidate.origin?.requestId !== requestId ||
                  candidate.origin?.digest !== requestDigest)
              ) {
                conflict();
              }
            }
          }
          if (recovered !== undefined) {
            const result = { scheduleId: recovered.id, status: "created" };
            const recorded = store.recordLocalMutation(
              caller.id,
              requestId,
              requestDigest,
              result,
            );
            return { ...replay(recorded.result), duplicate: true };
          }
          const endpoint = endpointFor(store, caller, userId, selectedChannel);
          let sessionId = "";
          if (action === "wake") {
            sessionId = stringValue(params.sessionId, 256);
            const target = store.localTargets([userId])[0];
            if (
              target?.sessions.find(
                (session) =>
                  session.id === sessionId && session.state === "active",
              ) === undefined
            )
              reject();
          } else if (params.sessionId !== undefined) {
            reject();
          }
          if (wakeStore.list(userId).length >= MAX_SCHEDULES_PER_USER)
            throw new LocalControlError("busy");
          store.assertLocalMutationAllowed(caller.id);
          const input: Omit<
            WakeSchedule,
            "id" | "fireCount" | "lastFiredAt" | "createdAt"
          > = {
            ownerId: userId,
            channel: endpoint.channel,
            endpointId: endpoint.endpoint.id,
            action,
            sessionId,
            promptTemplate: text,
            timezone,
            timeOfDay,
            recurrence: rec,
            enabled: true,
            cancelled: false,
            maxFires: null,
            until: null,
            origin: { callerId: caller.id, requestId, digest: requestDigest },
          };
          const now = store.clock.now();
          const next = nextFireAfter(
            {
              ...input,
              id: scheduleId,
              createdAt: new Date(now).toISOString(),
              fireCount: 0,
              lastFiredAt: null,
            },
            now,
          );
          if (next === null || next <= now) reject();
          const schedule = wakeStore.add(input, scheduleId);
          const result = {
            scheduleId: schedule.id,
            status: "created",
            nextFire: new Date(next).toISOString(),
            timezone,
          };
          const recorded = store.recordLocalMutation(
            caller.id,
            requestId,
            requestDigest,
            result,
          );
          return {
            ...(recorded.result as RecordValue),
            duplicate: recorded.duplicate,
          };
        }
        case "schedule.set_enabled": {
          exactKeys(params, ["requestId", "userId", "scheduleId", "enabled"]);
          const userId = checkUser(caller, params.userId);
          if (typeof params.enabled !== "boolean") reject();
          const requestId = mutationId(params);
          const requestDigest = digest(request.method, params);
          const receipt = store.localRequest(caller.id, requestId);
          if (receipt !== null) {
            if (receipt.digest !== requestDigest) conflict();
            return replay(receipt.result);
          }
          const wakeStore = application.localWakeStore(userId);
          if (wakeStore.fileError !== null) unavailable();
          const schedule = ownedExternal(
            wakeStore.get(stringValue(params.scheduleId, 64)),
            caller,
            userId,
          );
          if (schedule.cancelled === true && params.enabled) conflict();
          store.assertLocalMutationAllowed(caller.id);
          if (!wakeStore.setEnabled(schedule.id, params.enabled)) conflict();
          const result = { scheduleId: schedule.id, enabled: params.enabled };
          const recorded = store.recordLocalMutation(
            caller.id,
            requestId,
            requestDigest,
            result,
          );
          return {
            ...(recorded.result as RecordValue),
            duplicate: recorded.duplicate,
          };
        }
        case "schedule.cancel": {
          exactKeys(params, ["requestId", "userId", "scheduleId"]);
          const userId = checkUser(caller, params.userId);
          const requestId = mutationId(params);
          const requestDigest = digest(request.method, params);
          const receipt = store.localRequest(caller.id, requestId);
          if (receipt !== null) {
            if (receipt.digest !== requestDigest) conflict();
            return replay(receipt.result);
          }
          const wakeStore = application.localWakeStore(userId);
          if (wakeStore.fileError !== null) unavailable();
          const schedule = ownedExternal(
            wakeStore.get(stringValue(params.scheduleId, 64)),
            caller,
            userId,
          );
          store.assertLocalMutationAllowed(caller.id);
          if (!wakeStore.cancel(schedule.id)) notFound();
          const result = { scheduleId: schedule.id, cancelled: true };
          const recorded = store.recordLocalMutation(
            caller.id,
            requestId,
            requestDigest,
            result,
          );
          return {
            ...(recorded.result as RecordValue),
            duplicate: recorded.duplicate,
          };
        }
      }
    } catch (error) {
      return mapError(error);
    }
  };
}
