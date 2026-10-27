import assert from "node:assert/strict";
import test from "node:test";
import { comfyRuntimeGuidance } from "../src/comfyui/guidance.js";

test("agent guidance requires details, inspection and explicit publication without automatic-delivery claims", () => {
  const text = comfyRuntimeGuidance("agent");
  assert.match(text, /paint_get_details/);
  assert.match(text, /Inspect the actual image/);
  assert.match(text, /hitch_publish/);
  assert.match(text, /Do not poll/);
  assert.match(text, /remaining job budget/);
  assert.doesNotMatch(
    text,
    /automatically sends|promptly reply with its short job ID/,
  );
  assert.match(text, /video file path does NOT mean you have watched it/);
});

test("completion guidance carries trusted job, remaining budget and persistent publish path", () => {
  const text = comfyRuntimeGuidance(
    "agent",
    {
      jobId: "paint_test",
      outcome: "completed",
      rootTurnId: "turn_root",
      remainingJobs: 2,
    },
    [
      {
        path: "/workspace/paint-artifact.png",
        relativePath: "paint-artifact.png",
      },
    ],
  );
  assert.match(text, /"job_id":"paint_test"/);
  assert.match(text, /"remaining_jobs":2/);
  assert.match(text, /"publish_path":"paint-artifact.png"/);
  assert.match(text, /not a new user request/);
  assert.doesNotMatch(text, /turn_root/);
});

test("failure guidance does not promise an artifact or successful completion", () => {
  const text = comfyRuntimeGuidance("agent", {
    jobId: "paint_fail",
    outcome: "failed",
    rootTurnId: "turn_root",
    remainingJobs: 0,
  });
  assert.match(text, /This generation failed/);
  assert.match(text, /Do not claim a result exists/);
  assert.doesNotMatch(text, /Verified workspace originals/);
});

test("legacy direct mode preserves background delivery but learns workflow details", () => {
  const text = comfyRuntimeGuidance("direct");
  assert.match(text, /paint_get_details/);
  assert.match(text, /Hitch automatically sends/);
  assert.doesNotMatch(text, /agent-controlled delivery mode/);
});
