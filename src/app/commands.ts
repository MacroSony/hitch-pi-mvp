import type { WakeRecurrence } from "../wake/types.js";
import { AppError } from "./errors.js";

export const ALLOWED_DAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export type DayOfWeek = (typeof ALLOWED_DAYS)[number];

export type WakeCommand =
  | { readonly kind: "wake"; readonly action: "list" }
  | { readonly kind: "wake"; readonly action: "del"; readonly id: string }
  | { readonly kind: "wake"; readonly action: "pause"; readonly id: string }
  | { readonly kind: "wake"; readonly action: "resume"; readonly id: string }
  | { readonly kind: "wake"; readonly action: "tz"; readonly tz: string }
  | {
      readonly kind: "wake";
      readonly action: "add";
      readonly recurrence: WakeRecurrence;
      readonly timeOfDay: string;
      readonly prompt: string;
      readonly tz?: string;
    };

export type Command =
  | { readonly kind: "new"; readonly name?: string }
  | { readonly kind: "sessions" }
  | { readonly kind: "switch"; readonly selector: string }
  | { readonly kind: "status" }
  | { readonly kind: "abort" }
  | { readonly kind: "stop" }
  | { readonly kind: "recover" }
  | { readonly kind: "models"; readonly filter?: string }
  | { readonly kind: "model"; readonly selector: string }
  | { readonly kind: "thinking"; readonly level: string }
  | { readonly kind: "preset"; readonly action: "list" | "status" | "clear" }
  | {
      readonly kind: "preset";
      readonly action: "use" | "preview";
      readonly id: string;
    }
  | { readonly kind: "profile"; readonly action: "list" | "status" | "clear" }
  | {
      readonly kind: "profile";
      readonly action: "use" | "preview";
      readonly id: string;
    }
  | { readonly kind: "send"; readonly path: string }
  | { readonly kind: "compact" }
  | { readonly kind: "help" }
  | WakeCommand
  | { readonly kind: "unknown"; readonly name: string };

export const HELP_TEXT = [
  "!new [name] - create and select a session",
  "!sessions - list sessions",
  "!switch <id-or-name> - select a session",
  "!status - session, model, queue, and sandbox state",
  "!abort - cancel the active Turn",
  "!stop - stop the session and cancel queued Turns",
  "!recover - replace a quarantined session",
  "!models [filter] - list available models",
  "!model <provider>/<id> - select a model",
  "!thinking <level> - select a thinking level",
  "!preset [list|use <id>|preview <id>|status|clear] - manage preset prompt stacks",
  "!profile [list|use <id>|preview <id>|status|clear] - manage persona profiles",
  "!wake [add|list|del|pause|resume|tz] - manage scheduled wake prompts",
  "!send <relative-path> - publish a workspace file",
  "!compact - compact the session context",
  "!help - show this list",
].join("\n");

function boundedArgument(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new AppError("rejected", `${label} is required`);
  if (
    Buffer.byteLength(trimmed, "utf8") > 64 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new AppError("rejected", `${label} is invalid`);
  }
  return trimmed;
}

function boundedForgeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new AppError("rejected", `${label} is required`);
  if (
    Buffer.byteLength(trimmed, "utf8") > 64 ||
    /[\u0000-\u001f\u007f/\\]/u.test(trimmed)
  ) {
    throw new AppError("rejected", `${label} is invalid`);
  }
  return trimmed;
}

function boundedPath(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    Buffer.byteLength(trimmed, "utf8") > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new AppError("rejected", "workspace relative path is invalid");
  }
  return trimmed;
}

function boundedPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new AppError("rejected", "prompt is required");
  if (Buffer.byteLength(trimmed, "utf8") > 64 * 1024) {
    throw new AppError("rejected", "prompt is too long");
  }
  return trimmed;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validatedTimezone(tz: string): string {
  const trimmed = tz.trim();
  if (trimmed.length === 0)
    throw new AppError("rejected", "timezone is required");
  if (!isValidTimezone(trimmed))
    throw new AppError("rejected", `invalid timezone: ${trimmed}`);
  return trimmed;
}

function isValidDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateStr)) return false;
  const [year, month, day] = dateStr.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined)
    return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function validatedDate(dateStr: string): string {
  const trimmed = dateStr.trim();
  if (trimmed.length === 0)
    throw new AppError(
      "rejected",
      "date is required for once recurrence (YYYY-MM-DD)",
    );
  if (!isValidDate(trimmed))
    throw new AppError(
      "rejected",
      `invalid date: ${trimmed} (expected YYYY-MM-DD)`,
    );
  return trimmed;
}

function validatedTime(timeStr: string, label = "time"): string {
  const trimmed = timeStr.trim();
  if (trimmed.length === 0)
    throw new AppError("rejected", `${label} is required (HH:MM)`);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(trimmed))
    throw new AppError(
      "rejected",
      `invalid time format: ${trimmed} (expected HH:MM)`,
    );
  return trimmed;
}

function parseDays(value: string): number[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AppError(
      "rejected",
      "weekdays are required for weekly recurrence (e.g. mon,wed,fri)",
    );
  }
  const parts = trimmed.split(",");
  const days: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    const day = part.trim().toLowerCase();
    if (!ALLOWED_DAYS.includes(day as DayOfWeek)) {
      throw new AppError(
        "rejected",
        `invalid weekday token: ${part} (allowed: sun, mon, tue, wed, thu, fri, sat)`,
      );
    }
    const index = ALLOWED_DAYS.indexOf(day as DayOfWeek);
    if (!seen.has(index)) {
      seen.add(index);
      days.push(index);
    }
  }
  if (days.length === 0) {
    throw new AppError(
      "rejected",
      "at least one valid weekday is required for weekly recurrence",
    );
  }
  days.sort((a, b) => a - b);
  return days;
}

function parseTzAndPrompt(text: string): { tz?: string; prompt: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new AppError("rejected", "prompt is required");
  }
  if (trimmed === "--tz" || /^--tz\s*$/u.test(trimmed)) {
    throw new AppError("rejected", "timezone is required after --tz");
  }
  if (/^--tz(?:\s+|$)/u.test(trimmed)) {
    const afterFlag = trimmed.slice(4).trim();
    const tzMatch = afterFlag.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
    const tzStr = tzMatch?.[1] ?? "";
    const validatedTz = validatedTimezone(tzStr);
    const promptText = tzMatch?.[2]?.trim() ?? "";
    if (promptText.length === 0) {
      throw new AppError("rejected", "prompt is required");
    }
    return { tz: validatedTz, prompt: boundedPrompt(promptText) };
  }
  return { prompt: boundedPrompt(trimmed) };
}

function parseWakeCommand(argument: string): WakeCommand {
  const trimmed = argument.trim();
  if (trimmed.length === 0) {
    throw new AppError(
      "rejected",
      "wake subcommand is required (add, list, del, pause, resume, tz)",
    );
  }
  const firstSpace = trimmed.search(/\s/u);
  const action = (
    firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
  ).toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  switch (action) {
    case "list": {
      if (rest.length > 0) {
        throw new AppError("rejected", "unexpected argument for !wake list");
      }
      return { kind: "wake", action: "list" };
    }
    case "del":
    case "pause":
    case "resume": {
      if (rest.length === 0) {
        throw new AppError("rejected", "schedule id is required");
      }
      const parts = rest.split(/\s+/u);
      if (parts.length > 1) {
        throw new AppError(
          "rejected",
          `unexpected argument for !wake ${action}`,
        );
      }
      return {
        kind: "wake",
        action,
        id: boundedArgument(parts[0]!, "schedule id"),
      };
    }
    case "tz": {
      if (rest.length === 0) {
        throw new AppError("rejected", "timezone is required");
      }
      const parts = rest.split(/\s+/u);
      if (parts.length > 1) {
        throw new AppError("rejected", "unexpected argument for !wake tz");
      }
      return {
        kind: "wake",
        action: "tz",
        tz: validatedTimezone(parts[0]!),
      };
    }
    case "add": {
      if (rest.length === 0) {
        throw new AppError(
          "rejected",
          "recurrence type is required (daily, weekly, once)",
        );
      }
      const typeMatch = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
      const recurrenceType = typeMatch?.[1]?.toLowerCase();
      const afterType = typeMatch?.[2]?.trim() ?? "";

      switch (recurrenceType) {
        case "daily": {
          if (afterType.length === 0) {
            throw new AppError(
              "rejected",
              "time is required for daily recurrence (HH:MM)",
            );
          }
          const timeMatch = afterType.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
          const timeStr = timeMatch?.[1] ?? "";
          const time = validatedTime(timeStr, "time");
          const afterTime = timeMatch?.[2]?.trim() ?? "";
          const { tz, prompt } = parseTzAndPrompt(afterTime);
          return {
            kind: "wake",
            action: "add",
            recurrence: { kind: "daily" },
            timeOfDay: time,
            prompt,
            ...(tz !== undefined ? { tz } : {}),
          };
        }
        case "weekly": {
          if (afterType.length === 0) {
            throw new AppError(
              "rejected",
              "weekdays are required for weekly recurrence (e.g. mon,wed,fri)",
            );
          }
          const daysMatch = afterType.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
          const daysStr = daysMatch?.[1] ?? "";
          const days = parseDays(daysStr);
          const afterDays = daysMatch?.[2]?.trim() ?? "";
          if (afterDays.length === 0) {
            throw new AppError(
              "rejected",
              "time is required for weekly recurrence (HH:MM)",
            );
          }
          const timeMatch = afterDays.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
          const timeStr = timeMatch?.[1] ?? "";
          const time = validatedTime(timeStr, "time");
          const afterTime = timeMatch?.[2]?.trim() ?? "";
          const { tz, prompt } = parseTzAndPrompt(afterTime);
          return {
            kind: "wake",
            action: "add",
            recurrence: { kind: "weekly", weekdays: days },
            timeOfDay: time,
            prompt,
            ...(tz !== undefined ? { tz } : {}),
          };
        }
        case "once": {
          if (afterType.length === 0) {
            throw new AppError(
              "rejected",
              "date is required for once recurrence (YYYY-MM-DD)",
            );
          }
          const dateMatch = afterType.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
          const dateStr = dateMatch?.[1] ?? "";
          const date = validatedDate(dateStr);
          const afterDate = dateMatch?.[2]?.trim() ?? "";
          if (afterDate.length === 0) {
            throw new AppError(
              "rejected",
              "time is required for once recurrence (HH:MM)",
            );
          }
          const timeMatch = afterDate.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
          const timeStr = timeMatch?.[1] ?? "";
          const time = validatedTime(timeStr, "time");
          const afterTime = timeMatch?.[2]?.trim() ?? "";
          const { tz, prompt } = parseTzAndPrompt(afterTime);
          return {
            kind: "wake",
            action: "add",
            recurrence: { kind: "once", date },
            timeOfDay: time,
            prompt,
            ...(tz !== undefined ? { tz } : {}),
          };
        }
        default:
          throw new AppError(
            "rejected",
            `unknown recurrence type: ${recurrenceType} (expected daily, weekly, or once)`,
          );
      }
    }
    default:
      throw new AppError("rejected", `unknown wake subcommand ${action}`);
  }
}

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  const firstSpace = trimmed.search(/\s/u);
  const name = (
    firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)
  ).toLowerCase();
  const argument = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  switch (name) {
    case "new": {
      const value = argument.trim();
      return value.length === 0
        ? { kind: "new" }
        : { kind: "new", name: boundedArgument(value, "session name") };
    }
    case "sessions":
      return { kind: "sessions" };
    case "switch":
      return {
        kind: "switch",
        selector: boundedArgument(argument, "session selector"),
      };
    case "status":
      return { kind: "status" };
    case "abort":
      return { kind: "abort" };
    case "stop":
      return { kind: "stop" };
    case "recover":
      return { kind: "recover" };
    case "models": {
      const value = argument.trim();
      return value.length === 0
        ? { kind: "models" }
        : { kind: "models", filter: boundedArgument(value, "model filter") };
    }
    case "model":
      return {
        kind: "model",
        selector: boundedArgument(argument, "model selector"),
      };
    case "thinking":
      return {
        kind: "thinking",
        level: boundedArgument(argument, "thinking level").toLowerCase(),
      };
    case "preset":
    case "profile": {
      const trimmedArg = argument.trim();
      if (trimmedArg.length === 0) {
        return { kind: name, action: "status" };
      }
      const parts = trimmedArg.split(/\s+/u);
      const action = parts[0]?.toLowerCase();
      if (action === "list" || action === "status" || action === "clear") {
        if (parts.length > 1) {
          throw new AppError(
            "rejected",
            `unexpected argument for !${name} ${action}`,
          );
        }
        return { kind: name, action };
      }
      if (action === "use" || action === "preview") {
        if (
          parts.length < 2 ||
          parts[1] === undefined ||
          parts[1].length === 0
        ) {
          throw new AppError("rejected", `${name} id is required`);
        }
        if (parts.length > 2) {
          throw new AppError("rejected", `${name} id is invalid`);
        }
        return {
          kind: name,
          action,
          id: boundedForgeId(parts[1], `${name} id`),
        };
      }
      throw new AppError("rejected", `unknown ${name} subcommand ${action}`);
    }
    case "wake":
      return parseWakeCommand(argument);
    case "send":
      return { kind: "send", path: boundedPath(argument) };
    case "compact":
      if (argument.trim().length > 0)
        throw new AppError("rejected", "!compact takes no arguments");
      return { kind: "compact" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "unknown", name: name.slice(0, 64) };
  }
}
