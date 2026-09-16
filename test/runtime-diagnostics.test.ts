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

test("runtime diagnostics never echo secrets or newline-controlled input", () => {
  const secret = "Bearer top-secret\nforged-log";
  const line = logged({
    phase: "prompt",
    turnId: "turn-1\nforged",
    error: new Error(`HTTP 401 Authorization: ${secret} /private/path`),
  });
  assert.equal(line.includes(secret), false);
  assert.equal(line.includes("forged"), false);
  assert.equal(line.includes("/private/path"), false);
  assert.equal(line.includes("\n"), false);
  assert.deepEqual(JSON.parse(line), {
    event: "pi-runtime-failure",
    phase: "prompt",
    code: "auth",
    httpStatus: 401,
  });
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
