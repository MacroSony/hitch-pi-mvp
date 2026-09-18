import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRuntimeError,
  logPiRuntimeFailure,
} from "../src/pi/runtime-diagnostics.js";

function logged(input: Parameters<typeof logPiRuntimeFailure>[0]): string {
  const original = console.error;
  let line = "";
  console.error = (value: unknown) => {
    line = String(value);
  };
  try {
    assert.equal(logPiRuntimeFailure(input), line);
    return line;
  } finally {
    console.error = original;
  }
}

test("runtime diagnostics carry bounded detail but redact bearer tokens", () => {
  const secret = "Bearer top-secret\nforged-log";
  const line = logged({
    phase: "prompt",
    turnId: "turn-1\nforged",
    error: new Error(`HTTP 401 Authorization: ${secret} /private/path`),
  });
  // turnId still refuses newline-controlled input (dropped by TURN_ID).
  assert.equal(line.includes("turn-1"), false);
  // No raw newlines in the emitted line.
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed.event, "pi-runtime-failure");
  assert.equal(parsed.phase, "prompt");
  assert.equal(parsed.code, "auth");
  assert.equal(parsed.httpStatus, 401);
  // Detail is present and content-bearing, but the bearer token is redacted
  // and newlines are collapsed.
  assert.equal(typeof parsed.detail, "string");
  assert.equal((parsed.detail as string).includes("top-secret"), false);
  assert.equal((parsed.detail as string).includes("Bearer <redacted>"), true);
  assert.equal((parsed.detail as string).includes("/private/path"), true);
  assert.equal((parsed.detail as string).includes("\n"), false);
});

test("runtime diagnostics bound detail length", () => {
  const line = logged({
    phase: "prompt",
    error: new Error("x".repeat(8_192)),
  });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal((parsed.detail as string).length, 1_024);
});

test("runtime diagnostics do not emit unknown supplied codes", () => {
  const line = logged({
    phase: "spawn",
    error: "unrecognised remote body",
    code: "provider-body-secret" as never,
  });
  assert.equal(line.includes("provider-body-secret"), false);
  assert.equal(JSON.parse(line).code, "unknown");
  const combined = logged({ phase: "spawn", code: "auth quota" as never });
  assert.equal(JSON.parse(combined).code, "unknown");
});

test("runtime errors classify formatted HTTP quota, network, and timeout failures", () => {
  assert.deepEqual(classifyRuntimeError("HTTP 403: quota exceeded"), {
    code: "quota",
    httpStatus: 403,
  });
  assert.equal(classifyRuntimeError(new Error("ECONNRESET")).code, "network");
  assert.equal(classifyRuntimeError("request timed out").code, "timeout");
  assert.equal(
    classifyRuntimeError("user entered 403 apples").httpStatus,
    undefined,
  );
});

test("runtime diagnostics retain a normal host-safe turn id", () => {
  const line = logged({
    phase: "settled",
    turnId: "turn-01.alpha",
    error: "rpc failure",
  });
  assert.equal(JSON.parse(line).turnId, "turn-01.alpha");
});
