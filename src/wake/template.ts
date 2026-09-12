export function renderWakeTemplate(
  template: string,
  timezone: string,
  nowUtcMs: number,
): string {
  if (!template.includes("{{")) {
    return template;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(new Date(nowUtcMs));
  let year = "";
  let month = "";
  let day = "";
  let hour = "";
  let minute = "";
  let weekday = "";

  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
    else if (part.type === "hour") hour = part.value;
    else if (part.type === "minute") minute = part.value;
    else if (part.type === "weekday") weekday = part.value;
  }

  const date = `${year}-${month}-${day}`;
  const time = `${hour}:${minute}`;
  const datetime = `${date} ${time}`;

  const vars: Record<string, string> = {
    date,
    time,
    datetime,
    weekday,
    timezone,
  };

  return template.replace(/\{\{([^{}]+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match;
  });
}
