// Explicit opt-in: real provider, isolated database/workspace, fixture-only backend.
// No Discord worker is constructed; no ComfyUI HTTP request is made.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.HITCH_RUN_NATIVE_PAINT_PROBE !== "1")
  throw new Error("Explicit opt-in required");
const [profile, fixtureImage, policyFile] = process.argv.slice(2);
if (!profile || !fixtureImage || !policyFile)
  throw new Error(
    "Usage: probe <provider-profile-dir> <fixture-png> <operator-policy-file>",
  );
process.umask(0o077);
const base = pathToFileURL(resolve("dist/src")).href;
const { parseConfig } = await import(base + "/config/config.js");
const { bootstrapFoundation } = await import(base + "/foundation/bootstrap.js");
const { HitchStore } = await import(base + "/app/store.js");
const { HitchApplication } = await import(base + "/app/application.js");
const { MediaStore } = await import(base + "/media/media-store.js");
const { ComfyService } = await import(base + "/comfyui/service.js");
const { loadComfyPolicies } = await import(base + "/comfyui/config.js");
const { NativePiRuntime } = await import(base + "/pi/native-runtime.js");
const root = mkdtempSync(join(tmpdir(), "hitch-native-agent-flow-"));
const dir = (name) => {
  const p = join(root, name);
  mkdirSync(p, { mode: 0o700 });
  return p;
};
const owner = "flow-probe";
const config = parseConfig({
  schemaVersion: 1,
  dataRoot: dir("data"),
  piProfileDir: resolve(profile),
  minimumFreeBytes: 0,
  telegramAccounts: [],
  wechatAccounts: [],
  discordAccounts: [{ id: "isolated", botTokenEnv: "UNUSED_FIXTURE_TOKEN" }],
  users: [
    {
      id: owner,
      workspace: dir("workspace"),
      discord: {
        mode: "dm",
        account: "isolated",
        userId: "123456789012345680",
        channelId: "123456789012345682",
      },
    },
  ],
});
const foundation = bootstrapFoundation(config),
  store = new HitchStore(foundation.database),
  media = new MediaStore(join(config.dataRoot, "media"), 0);
const db = foundation.database.connection;
const calls = [];
const submissions = [];
const bytes = readFileSync(fixtureImage);
const backend = {
  async submit(graph) {
    submissions.push(graph);
    return `fixture-${submissions.length}`;
  },
  async history() {
    return {
      state: "completed",
      images: [{ filename: "fixture.png", subfolder: "", type: "output" }],
    };
  },
  async download() {
    return bytes;
  },
  async cancel() {
    return false;
  },
};
let application;
store.configureComfyContinuation([owner]);
const workflows = loadComfyPolicies(resolve(policyFile)).filter(
  (p) => p.definition.id === "anima",
);
assert.equal(workflows.length, 1);
const paint = new ComfyService({
  ledger: store,
  media,
  backend,
  workflows,
  enabledUsers: [owner],
  deliveryMode: "agent",
  onContinuationReady: (user) => application.dispatchQueuedUser(user),
});
const observedPaint = {
  deliveryMode: "agent",
  enabledUsers: [owner],
  async execute(context, name, input, signal) {
    calls.push({ name, input });
    return paint.execute(context, name, input, signal);
  },
};
let stage = "create-runtime";
try {
  const runtime = await NativePiRuntime.create({
    dataRoot: config.dataRoot,
    piProfileDir: config.piProfileDir,
    userIds: [owner],
    mediaStore: media,
    paint: observedPaint,
    turnTimeoutMs: 120000,
  });
  const ep = store.resolveDiscordEndpoint(
    "isolated",
    "dm",
    "123456789012345680",
    "123456789012345682",
  );
  const id = "operator:native-agent-flow";
  // Prompt authored by Mika. The fixed fixture tests orchestration, NOT quality of newly generated art.
  store.admitPrompt(
    {
      endpoint: ep,
      idempotencyKey: id,
      contentDigest: createHash("sha256").update(id).digest("hex"),
    },
    "请用 Anima 画一张猫耳女仆坐在电脑前的插画。出图后你自己看一下画面，用一两句说清楚实际画到了什么，再把原图作为文件发给我。只要一张，不要额外变体，不需要视频。",
  );
  db.prepare(
    "UPDATE sessions SET model_provider='openai-codex', model_id='gpt-6-luna', thinking_level='medium' WHERE user_id=?",
  ).run(owner);
  const turnReceipts = [];
  const observedRuntime = {
    models: runtime.models,
    forge: runtime.forge,
    async run(turn, signal, onProgress) {
      const result = await runtime.run(turn, signal, onProgress);
      turnReceipts.push({
        turnId: turn.turnId,
        continuation: turn.comfyContinuation ?? null,
        outcome: result.outcome,
        text: result.text,
        artifacts: result.artifacts ?? [],
        transcriptPath: result.transcriptPath,
      });
      return result;
    },
  };
  application = new HitchApplication(
    store,
    observedRuntime,
    "always-trigger",
    media,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    config.users,
    [owner],
  );
  stage = "initial-turn";
  application.start();
  await application.drain();
  assert.equal(
    submissions.length,
    1,
    "initial model must submit exactly one fixture generation",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM outbox").get().n,
    0n,
    "no initial job-id chatter or file delivery",
  );
  stage = "continuation";
  await paint.tick();
  await application.drain();
  const jobs = db
    .prepare("SELECT id,state,completion_turn_id FROM comfy_jobs")
    .all();
  const outbox = db.prepare("SELECT kind,payload_text,state FROM outbox").all();
  assert.equal(submissions.length, 1, "retrieval/review must not regenerate");
  assert.equal(
    turnReceipts.length,
    2,
    "one request plus exactly one internal continuation",
  );
  assert.ok(turnReceipts.every((t) => t.outcome === "succeeded"));
  const final = turnReceipts.at(-1);
  assert.equal(
    final.artifacts.length,
    1,
    "model must explicitly publish a selected file",
  );
  assert.equal(
    final.artifacts[0].sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.ok(
    calls.some((c) => c.name === "paint_get_details"),
    "model must read workflow NOTE through details",
  );
  assert.equal(outbox.filter((o) => o.kind === "artifact").length, 1);
  assert.ok(
    outbox.every(
      (o) => !/^你的(图像|视频)已生成。$/.test(o.payload_text ?? ""),
    ),
  );
  const originals = db
    .prepare(
      "SELECT a.* FROM comfy_jobs j JOIN turn_artifacts ta ON ta.turn_id=j.completion_turn_id AND ta.direction='inbound' JOIN artifacts a ON a.id=ta.artifact_id",
    )
    .all();
  const receipt = {
    root,
    stage: "passed",
    provider: "openai-codex/gpt-6-luna",
    fixtureBackend: true,
    newGpuJobs: 0,
    discordWorkers: 0,
    externalMessages: 0,
    calls,
    turns: turnReceipts,
    jobs,
    outbox,
    originals,
  };
  writeFileSync(
    join(root, "receipt.json"),
    JSON.stringify(
      receipt,
      (_k, v) => (typeof v === "bigint" ? Number(v) : v),
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      root,
      outcome: "passed",
      newGpuJobs: 0,
      externalMessages: 0,
      toolCalls: calls.map((c) => c.name),
      finalText: final.text,
    }),
  );
} catch (error) {
  writeFileSync(
    join(root, "failure.json"),
    JSON.stringify({ stage, error: String(error), calls }, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.error(
    JSON.stringify({
      root,
      stage,
      outcome: "failed",
      error: String(error),
      automaticRetry: false,
    }),
  );
  process.exitCode = 1;
} finally {
  foundation.close();
}
