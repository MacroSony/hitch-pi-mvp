import assert from "node:assert/strict";
import test from "node:test";

import { renderWakeTemplate } from "../src/wake/template.js";

test("template rendering across timezones on cross-midnight instant 2026-03-09T01:30:00Z", () => {
  const utcMs = Date.parse("2026-03-09T01:30:00.000Z");

  // In Asia/Shanghai (UTC+8): 2026-03-09 09:30 Monday
  assert.equal(
    renderWakeTemplate("Today is {{date}}", "Asia/Shanghai", utcMs),
    "Today is 2026-03-09",
  );
  assert.equal(
    renderWakeTemplate("Current time: {{time}}", "Asia/Shanghai", utcMs),
    "Current time: 09:30",
  );
  assert.equal(
    renderWakeTemplate("Timestamp: {{datetime}}", "Asia/Shanghai", utcMs),
    "Timestamp: 2026-03-09 09:30",
  );
  assert.equal(
    renderWakeTemplate("Happy {{weekday}}!", "Asia/Shanghai", utcMs),
    "Happy Monday!",
  );
  assert.equal(
    renderWakeTemplate("Zone: {{timezone}}", "Asia/Shanghai", utcMs),
    "Zone: Asia/Shanghai",
  );

  // In America/Toronto (EDT UTC-4 on 2026-03-08): 2026-03-08 21:30 Sunday
  assert.equal(
    renderWakeTemplate("Today is {{date}}", "America/Toronto", utcMs),
    "Today is 2026-03-08",
  );
  assert.equal(
    renderWakeTemplate("Current time: {{time}}", "America/Toronto", utcMs),
    "Current time: 21:30",
  );
  assert.equal(
    renderWakeTemplate("Timestamp: {{datetime}}", "America/Toronto", utcMs),
    "Timestamp: 2026-03-08 21:30",
  );
  assert.equal(
    renderWakeTemplate("Happy {{weekday}}!", "America/Toronto", utcMs),
    "Happy Sunday!",
  );
  assert.equal(
    renderWakeTemplate("Zone: {{timezone}}", "America/Toronto", utcMs),
    "Zone: America/Toronto",
  );

  // Combined template comparison
  const fullTemplate =
    "Wakeup at {{time}} on {{weekday}} ({{date}}). Full: {{datetime}} in {{timezone}}.";
  const shanghaiRendered = renderWakeTemplate(
    fullTemplate,
    "Asia/Shanghai",
    utcMs,
  );
  const torontoRendered = renderWakeTemplate(
    fullTemplate,
    "America/Toronto",
    utcMs,
  );

  assert.equal(
    shanghaiRendered,
    "Wakeup at 09:30 on Monday (2026-03-09). Full: 2026-03-09 09:30 in Asia/Shanghai.",
  );
  assert.equal(
    torontoRendered,
    "Wakeup at 21:30 on Sunday (2026-03-08). Full: 2026-03-08 21:30 in America/Toronto.",
  );
  assert.notEqual(shanghaiRendered, torontoRendered);
});

test("unrecognized template variables and case sensitivity are preserved as-is", () => {
  const utcMs = Date.parse("2026-03-09T01:30:00.000Z");

  // Unknown variable names
  assert.equal(
    renderWakeTemplate(
      "Hello {{name}}, value is {{foo_bar}} and {{123}}",
      "UTC",
      utcMs,
    ),
    "Hello {{name}}, value is {{foo_bar}} and {{123}}",
  );

  // Case-sensitive variable names
  assert.equal(
    renderWakeTemplate(
      "{{Date}} {{TIME}} {{DATETIME}} {{Weekday}} {{Timezone}}",
      "UTC",
      utcMs,
    ),
    "{{Date}} {{TIME}} {{DATETIME}} {{Weekday}} {{Timezone}}",
  );

  // Mix of known and unknown variables
  assert.equal(
    renderWakeTemplate(
      "Date: {{date}}, Unknown: {{user_name}}, Time: {{time}}",
      "UTC",
      utcMs,
    ),
    "Date: 2026-03-09, Unknown: {{user_name}}, Time: 01:30",
  );
});

test("templates without variables return original string as-is", () => {
  const utcMs = Date.parse("2026-03-09T01:30:00.000Z");

  assert.equal(
    renderWakeTemplate(
      "Simple prompt without any variables.",
      "Asia/Shanghai",
      utcMs,
    ),
    "Simple prompt without any variables.",
  );
  assert.equal(renderWakeTemplate("", "Asia/Shanghai", utcMs), "");
  assert.equal(
    renderWakeTemplate(
      "Single braces {date} and literal {time}",
      "America/Toronto",
      utcMs,
    ),
    "Single braces {date} and literal {time}",
  );
});

test("multiple occurrences of the same variable are all substituted", () => {
  const utcMs = Date.parse("2026-03-09T01:30:00.000Z");

  assert.equal(
    renderWakeTemplate(
      "{{date}} / {{date}} at {{time}} ({{time}} {{timezone}})",
      "Asia/Shanghai",
      utcMs,
    ),
    "2026-03-09 / 2026-03-09 at 09:30 (09:30 Asia/Shanghai)",
  );
});
