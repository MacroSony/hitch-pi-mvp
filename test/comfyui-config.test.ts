import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config/config.js";
import { loadComfyPolicies } from "../src/comfyui/config.js";

function config(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    dataRoot: "/srv/data",
    piProfileDir: "/srv/profile",
    minimumFreeBytes: 0,
    telegramAccounts: [],
    wechatAccounts: [],
    discordAccounts: [{ id: "bot", botTokenEnv: "TEST_TOKEN" }],
    users: [
      {
        id: "owner",
        workspace: "/srv/workspace",
        discord: {
          mode: "dm",
          account: "bot",
          userId: "20000000000000001",
          channelId: "20000000000000002",
        },
      },
    ],
    paint: {
      origin: "http://127.0.0.1:8188",
      allowPrivate: true,
      workflowFile: "/srv/operator/workflows.json",
      enabledUsers: ["owner"],
    },
  };
}
const definition = {
  id: "fixture",
  graph: {
    "1": { class_type: "PrimitiveString", inputs: { value: "test prompt" } },
  },
  variables: {
    prompt: { nodeId: "1", input: "value", type: "string", maxLength: 80 },
  },
  outputNodes: ["1"],
};

test("paint config is explicit, Discord-owner scoped, and never accepts arbitrary fields or credential URLs", () => {
  assert.equal(parseConfig(config()).paint?.origin, "http://127.0.0.1:8188");
  for (const bad of [
    "http://user:secret@127.0.0.1:8188",
    "http://127.0.0.1:8188/prompt",
    "file:///tmp/backend",
    "https://example.test/#fragment",
  ]) {
    const value = config();
    (value.paint as Record<string, unknown>).origin = bad;
    assert.throws(() => parseConfig(value));
  }
  for (const change of [
    { enabledUsers: ["foreign"] },
    { enabledUsers: ["owner", "owner"] },
    { workflowFile: "../workspace.json" },
    { allowPrivate: "true" },
    { arbitrary: true },
  ]) {
    const value = config();
    Object.assign(value.paint as object, change);
    assert.throws(() => parseConfig(value));
  }
  const disabled = config();
  delete disabled.paint;
  assert.equal(parseConfig(disabled).paint, undefined);
});

test("operator policies are bounded, canonical, private, immutable and outside model writable roots", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hitch-comfy-config-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "workflows.json");
  writeFileSync(file, JSON.stringify([definition]), { mode: 0o600 });
  const policies = loadComfyPolicies(file);
  assert.equal(policies[0]?.definition.id, "fixture");
  assert.equal(Object.isFrozen(policies), true);
  assert.throws(() => loadComfyPolicies(file, [root]));
  const link = join(root, "alias.json");
  symlinkSync(file, link);
  assert.throws(() => loadComfyPolicies(link));
  unlinkSync(link);
  linkSync(file, link);
  assert.throws(() => loadComfyPolicies(file));
  unlinkSync(link);
  chmodSync(file, 0o620);
  assert.throws(() => loadComfyPolicies(file));
  chmodSync(file, 0o600);
  writeFileSync(file, JSON.stringify([definition, definition]));
  assert.throws(() => loadComfyPolicies(file));
  const eight = Array.from({ length: 8 }, (_, i) => ({
    ...definition,
    id: `fixture${i}`,
  }));
  writeFileSync(file, JSON.stringify(eight));
  assert.equal(loadComfyPolicies(file).length, 8);
  writeFileSync(
    file,
    JSON.stringify([...eight, { ...definition, id: "fixture8" }]),
  );
  assert.throws(() => loadComfyPolicies(file));
  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => loadComfyPolicies(file));
  writeFileSync(file, "PRIVATEDETAIL invalid JSON");
  assert.throws(() => loadComfyPolicies(file), {
    message: "Comfy workflow configuration is invalid",
  });
  const publicRoot = join(root, "public");
  mkdirSync(publicRoot, { mode: 0o755 });
  const publicFile = join(publicRoot, "workflow.json");
  writeFileSync(publicFile, JSON.stringify([definition]), { mode: 0o600 });
  assert.throws(() => loadComfyPolicies(publicFile));
});
