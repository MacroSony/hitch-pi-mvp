import type { WakeSchedule } from "./types.js";

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getLocalParts(utcMs: number, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "second") second = Number(part.value);
  }
  return { year, month, day, hour, minute, second };
}

function getLocalAsUtcMs(utcMs: number, timeZone: string): number {
  const p = getLocalParts(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
}

function getOffsetMs(utcMs: number, timeZone: string): number {
  return getLocalAsUtcMs(utcMs, timeZone) - utcMs;
}

function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const targetLocalAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offCenter = getOffsetMs(targetLocalAsUtc, timeZone);
  const guess1 = targetLocalAsUtc - offCenter;
  const off1 = getOffsetMs(guess1, timeZone);
  const guess2 = targetLocalAsUtc - off1;
  const off2 = getOffsetMs(guess2, timeZone);
  const offBefore = getOffsetMs(targetLocalAsUtc - 86_400_000, timeZone);
  const offAfter = getOffsetMs(targetLocalAsUtc + 86_400_000, timeZone);

  const candidateOffsets = new Set([
    offCenter,
    off1,
    off2,
    offBefore,
    offAfter,
  ]);
  const exactMatches: number[] = [];
  for (const off of candidateOffsets) {
    const candidateUtc = targetLocalAsUtc - off;
    if (getLocalAsUtcMs(candidateUtc, timeZone) === targetLocalAsUtc) {
      exactMatches.push(candidateUtc);
    }
  }

  if (exactMatches.length > 0) {
    exactMatches.sort((a, b) => a - b);
    return exactMatches[0]!;
  }

  // Spring-forward DST gap: find next valid moment (instant when the jump occurs)
  let low = targetLocalAsUtc - 2 * 86_400_000;
  let high = targetLocalAsUtc + 2 * 86_400_000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getLocalAsUtcMs(mid, timeZone) >= targetLocalAsUtc) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

function addDays(
  y: number,
  m: number,
  d: number,
  days: number,
): { year: number; month: number; day: number; dateStr: string } {
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const dateStr = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  return { year, month, day, dateStr };
}

export function nextFireAfter(
  schedule: WakeSchedule,
  afterUtcMs: number,
): number | null {
  if (schedule.maxFires !== null && schedule.fireCount >= schedule.maxFires) {
    return null;
  }

  const [hourStr, minuteStr] = schedule.timeOfDay.split(":");
  if (hourStr === undefined || minuteStr === undefined) {
    return null;
  }
  const targetHour = Number(hourStr);
  const targetMinute = Number(minuteStr);

  if (schedule.recurrence.kind === "once") {
    if (schedule.lastFiredAt !== null) {
      return null;
    }
    if (schedule.until !== null && schedule.recurrence.date > schedule.until) {
      return null;
    }
    const [yStr, mStr, dStr] = schedule.recurrence.date.split("-");
    if (yStr === undefined || mStr === undefined || dStr === undefined) {
      return null;
    }
    return localToUtc(
      Number(yStr),
      Number(mStr),
      Number(dStr),
      targetHour,
      targetMinute,
      schedule.timezone,
    );
  }

  const p = getLocalParts(afterUtcMs, schedule.timezone);
  const allowedWeekdays =
    schedule.recurrence.kind === "weekly"
      ? new Set(schedule.recurrence.weekdays)
      : null;
  if (allowedWeekdays !== null && allowedWeekdays.size === 0) {
    return null;
  }

  for (let offset = -1; offset <= 1000; offset += 1) {
    const candidate = addDays(p.year, p.month, p.day, offset);
    if (schedule.until !== null && candidate.dateStr > schedule.until) {
      return null;
    }
    if (allowedWeekdays !== null) {
      const weekday = new Date(
        Date.UTC(candidate.year, candidate.month - 1, candidate.day),
      ).getUTCDay();
      if (!allowedWeekdays.has(weekday)) {
        continue;
      }
    }
    const fireUtcMs = localToUtc(
      candidate.year,
      candidate.month,
      candidate.day,
      targetHour,
      targetMinute,
      schedule.timezone,
    );
    if (fireUtcMs > afterUtcMs) {
      return fireUtcMs;
    }
  }

  return null;
}
