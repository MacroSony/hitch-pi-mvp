import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComfyService } from "../src/comfyui/service.js";
import { ComfyBackendError } from "../src/comfyui/client.js";
import { ComfyWorkflowPolicy } from "../src/comfyui/workflow.js";
import { MediaStore } from "../src/media/media-store.js";
import type { ComfyJob, ComfyJobLedger } from "../src/comfyui/types.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function fixture() {
  const policy = new ComfyWorkflowPolicy({
    id: "fixture",
    graph: {
      "1": {
        class_type: "Text",
        inputs: {
          value: "base",
          negative: "",
          width: 512,
          height: 512,
          seed: 0,
        },
      },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    },
    variables: {
      prompt: { nodeId: "1", input: "value", type: "string", maxLength: 8192 },
      negative: {
        nodeId: "1",
        input: "negative",
        type: "string",
        maxLength: 8192,
      },
      width: {
        nodeId: "1",
        input: "width",
        type: "integer",
        min: 64,
        max: 2048,
      },
      height: {
        nodeId: "1",
        input: "height",
        type: "integer",
        min: 64,
        max: 2048,
      },
      seed: {
        nodeId: "1",
        input: "seed",
        type: "integer",
        min: 0,
        max: 281474976710655,
      },
    },
    outputNodes: ["2"],
  });
  const jobs = new Map<string, ComfyJob>();
  let serial = 0;
  const ledger: ComfyJobLedger = {
    createComfyJob(userId, turnId, workflowId, snapshot) {
      const j: ComfyJob = {
        id: `job${++serial}`,
        userId,
        turnId,
        workflowId,
        snapshot,
        state: "prepared",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      jobs.set(j.id, j);
      return j;
    },
    getComfyJob(user, id) {
      const j = jobs.get(id);
      return j?.userId === user ? j : null;
    },
    listComfyJobs(user, limit = 20) {
      return [...jobs.values()]
        .filter((j) => j.userId === user)
        .slice(-limit)
        .reverse();
    },
    pendingComfyJobs(limit = 20) {
      return [...jobs.values()]
        .filter((j) => j.state === "submitted")
        .slice(0, limit);
    },
    markComfyJobSubmitting(user, id) {
      return update(user, id, { state: "submitting" });
    },
    markComfyJobSubmitted(user, id, backendPromptId) {
      return update(user, id, { state: "submitted", backendPromptId });
    },
    markComfyJobUnknown(user, id) {
      return update(user, id, { state: "submission_unknown" });
    },
    markComfyJobRejected(user, id) {
      return update(user, id, { state: "failed" });
    },
    markComfyJobCancelled(user, id) {
      return update(user, id, { state: "cancelled" });
    },
    recoverComfyJobs() {},
    finishComfyJob(user, id, outcome) {
      return update(user, id, { state: outcome });
    },
  };
  function update(user: string, id: string, patch: Partial<ComfyJob>): boolean {
    const j = jobs.get(id);
    if (!j || j.userId !== user) return false;
    jobs.set(id, { ...j, ...patch });
    return true;
  }
  return { policy, jobs, ledger };
}

test("Comfy service enforces owners, strict tool inputs, and reports cancel booleans", async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "comfy-service-"));
  try {
    let submissions = 0;
    let cancelResult: true | false | "unsupported" = false;
    const backend = {
      async submit() {
        submissions++;
        return "private_backend_id";
      },
      async cancel() {
        return cancelResult;
      },
      async history() {
        return { state: "pending" as const };
      },
      async download() {
        return png;
      },
    };
    const service = new ComfyService({
      ledger: f.ledger,
      media: new MediaStore(root),
      backend: backend as never,
      workflows: [f.policy],
      enabledUsers: ["alice", "bob"],
    });
    await assert.rejects(
      service.execute({ userId: "stranger", turnId: "t" }, "paint", {
        prompt: "test",
      }),
    );
    assert.equal(submissions, 0);
    await assert.rejects(
      service.execute({ userId: "alice", turnId: "t" }, "paint", {
        prompt: "test",
        graph: {},
      }),
    );
    const result = (await service.execute(
      { userId: "alice", turnId: "t" },
      "paint",
      { prompt: "plain test", width: 512 },
    )) as { id: string; state: string };
    assert.equal(result.state, "submitted");
    assert.equal(submissions, 1);
    assert.equal(f.jobs.get(result.id)?.backendPromptId, "private_backend_id");
    assert.deepEqual(
      await service.execute(
        { userId: "alice", turnId: "t" },
        "paint_job_status",
        { job_id: result.id },
      ),
      [{ id: result.id, workflow: "fixture", state: "submitted" }],
    );
    assert.deepEqual(
      await service.execute(
        { userId: "bob", turnId: "t" },
        "paint_job_status",
        { job_id: result.id },
      ),
      [],
    );
    const cancelled = (await service.execute(
      { userId: "alice", turnId: "t" },
      "paint_job_cancel",
      { job_id: result.id },
    )) as { cancel_result: boolean; state: string };
    assert.equal(cancelled.cancel_result, false);
    assert.equal(cancelled.state, "submitted");
    cancelResult = true;
    const stopped = (await service.execute(
      { userId: "alice", turnId: "t" },
      "paint_job_cancel",
      { job_id: result.id },
    )) as { cancel_result: boolean; state: string };
    assert.equal(stopped.state, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncertain submission is safely reported and never replayed", async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "comfy-service-"));
  let calls = 0;
  try {
    const backend = {
      async submit() {
        calls++;
        throw new ComfyBackendError("submission-unknown");
      },
      async cancel() {
        return "unsupported" as const;
      },
      async history() {
        return { state: "pending" as const };
      },
      async download() {
        return png;
      },
    };
    const service = new ComfyService({
      ledger: f.ledger,
      media: new MediaStore(root),
      backend: backend as never,
      workflows: [f.policy],
      enabledUsers: ["alice"],
    });
    const result = (await service.execute(
      { userId: "alice", turnId: "t" },
      "paint",
      { prompt: "plain test" },
    )) as { id: string; state: string };
    assert.equal(result.state, "submission_unknown");
    assert.equal(Object.keys(result).sort().join(","), "id,state,workflow");
    await service.tick();
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tick validates a single bounded image and serializes concurrent polling", async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "comfy-service-"));
  let calls = 0;
  try {
    let resolveHistory: (() => void) | undefined;
    const backend = {
      async submit() {
        return "backend";
      },
      async cancel() {
        return false as const;
      },
      async history() {
        calls++;
        if (calls === 1)
          await new Promise<void>((r) => {
            resolveHistory = r;
          });
        return {
          state: "complete" as const,
          images: [{ filename: "fixture.png", type: "output" as const }],
        };
      },
      async download() {
        return png;
      },
    };
    const service = new ComfyService({
      ledger: f.ledger,
      media: new MediaStore(root),
      backend: backend as never,
      workflows: [f.policy],
      enabledUsers: ["alice"],
    });
    await service.execute({ userId: "alice", turnId: "t" }, "paint", {
      prompt: "plain test",
    });
    const first = service.tick();
    await new Promise((r) => setTimeout(r, 5));
    const second = service.tick();
    resolveHistory?.();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal([...f.jobs.values()][0]?.state, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiple backend images fail instead of truncating", async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), "comfy-service-"));
  try {
    const backend = {
      async submit() {
        return "backend";
      },
      async cancel() {
        return false as const;
      },
      async history() {
        return {
          state: "complete" as const,
          images: [
            { filename: "a.png", type: "output" as const },
            { filename: "b.png", type: "output" as const },
          ],
        };
      },
      async download() {
        return png;
      },
    };
    const service = new ComfyService({
      ledger: f.ledger,
      media: new MediaStore(root),
      backend: backend as never,
      workflows: [f.policy],
      enabledUsers: ["alice"],
    });
    await service.execute({ userId: "alice", turnId: "t" }, "paint", {
      prompt: "plain test",
    });
    await service.tick();
    assert.equal([...f.jobs.values()][0]?.state, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
