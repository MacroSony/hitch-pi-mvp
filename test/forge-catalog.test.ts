import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createForgeCatalog } from "../src/forge/catalog.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hitch-forge-catalog-"));
  chmodSync(root, 0o700);
  mkdirSync(join(root, "prompt-stacks"), { mode: 0o700 });
  mkdirSync(join(root, "agent-profiles"), { mode: 0o700 });
  return root;
}

function stack(content = "Hello {{runtime.cwd}}") {
  return JSON.stringify({
    schemaVersion: 1,
    type: "pi-forge.prompt-stack",
    id: "welcome",
    name: "Welcome",
    items: [{ kind: "block", id: "system", role: "system", content }],
  });
}

function profile(id: string, promptStack: string | null = "welcome") {
  return JSON.stringify({
    schemaVersion: 1,
    type: "pi-forge.agent-profile",
    id,
    model: { provider: "operator", id: "model" },
    thinkingLevel: "medium",
    promptStack,
  });
}

test("catalog freezes an explicit root snapshot and keeps users/content host-neutral", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "prompt-stacks", "welcome.json"), stack(), {
      mode: 0o600,
    });
    writeFileSync(
      join(root, "agent-profiles", "writer.json"),
      profile("writer"),
      { mode: 0o600 },
    );
    const catalog = createForgeCatalog({ root, enabledUsers: ["alice"] });

    assert.equal(catalog.isEnabled("alice"), true);
    assert.equal(catalog.isEnabled("bob"), false);
    assert.deepEqual(catalog.list("preset"), [
      { kind: "preset", id: "welcome", name: "Welcome" },
    ]);
    assert.deepEqual(catalog.list("profile"), [
      { kind: "profile", id: "writer", name: "writer" },
    ]);
    const resolved = catalog.resolve({ kind: "profile", id: "writer" });
    assert.equal(resolved.systemPrompt, "Hello /workspace");
    assert.deepEqual(resolved.model, { provider: "operator", id: "model" });
    assert.equal(resolved.thinkingLevel, "medium");
    assert.equal(resolved.systemPrompt.includes(root), false);
    assert.equal(Object.isFrozen(resolved), true);

    writeFileSync(
      join(root, "prompt-stacks", "welcome.json"),
      stack("changed"),
      { mode: 0o600 },
    );
    assert.equal(
      catalog.resolve({ kind: "preset", id: "welcome" }).systemPrompt,
      "Hello /workspace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile without a model and global-qualified stack are supported", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "prompt-stacks", "welcome.json"), stack("Hi"), {
      mode: 0o600,
    });
    writeFileSync(
      join(root, "agent-profiles", "prompt-only.json"),
      JSON.stringify({
        schemaVersion: 1,
        type: "pi-forge.agent-profile",
        id: "prompt-only",
        thinkingLevel: "off",
        promptStack: "global:welcome",
      }),
      { mode: 0o600 },
    );
    const catalog = createForgeCatalog({ root, enabledUsers: [] });
    const resolved = catalog.resolve({ kind: "profile", id: "prompt-only" });
    assert.equal(resolved.model, undefined);
    assert.equal(resolved.systemPrompt, "Hi");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup rejects an unresolvable default profile and unsafe resource files", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "prompt-stacks", "welcome.json"), stack(), {
      mode: 0o600,
    });
    writeFileSync(
      join(root, "agent-profiles", "broken.json"),
      profile("broken", "missing"),
      { mode: 0o600 },
    );
    assert.throws(
      () => createForgeCatalog({ root, enabledUsers: [] }),
      (error: unknown) =>
        error instanceof Error && error.message === "forge-invalid",
    );

    rmSync(join(root, "agent-profiles", "broken.json"));
    const target = join(root, "prompt-stacks", "outside.json");
    writeFileSync(target, stack(), { mode: 0o600 });
    symlinkSync(target, join(root, "prompt-stacks", "link.json"));
    assert.throws(
      () => createForgeCatalog({ root, enabledUsers: [] }),
      /forge-unavailable/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog bounds hard links, file size, and total resource count", () => {
  const root = makeRoot();
  try {
    const source = join(root, "prompt-stacks", "welcome.json");
    writeFileSync(source, stack(), { mode: 0o600 });
    linkSync(source, join(root, "prompt-stacks", "second.json"));
    assert.throws(
      () => createForgeCatalog({ root, enabledUsers: [] }),
      /forge-unavailable/u,
    );

    rmSync(join(root, "prompt-stacks", "second.json"));
    writeFileSync(source, `${"x".repeat(64 * 1024)}\n`, { mode: 0o600 });
    assert.throws(
      () => createForgeCatalog({ root, enabledUsers: [] }),
      /forge-invalid|forge-unavailable/u,
    );

    rmSync(source);
    for (let index = 0; index < 129; index++) {
      writeFileSync(
        join(root, "prompt-stacks", `s${index}.json`),
        JSON.stringify({ id: `s${index}`, items: [] }),
        { mode: 0o600 },
      );
    }
    assert.throws(
      () => createForgeCatalog({ root, enabledUsers: [] }),
      /forge-invalid/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog exposes only generic resolve failures", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "prompt-stacks", "welcome.json"), stack(), {
      mode: 0o600,
    });
    const catalog = createForgeCatalog({ root, enabledUsers: [] });
    assert.throws(
      () => catalog.resolve({ kind: "preset", id: "missing" }),
      /forge-unavailable/u,
    );
    assert.throws(
      () => catalog.resolve({ kind: "preset", id: "../secret" }),
      /forge-invalid/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog rejects root aliases and workspace/service overlap", () => {
  const root = makeRoot();
  const link = root + "-link";
  try {
    symlinkSync(root, link);
    assert.throws(
      () => createForgeCatalog({ root: link, enabledUsers: ["alice"] }),
      /forge-unavailable/u,
    );
    assert.throws(
      () =>
        createForgeCatalog({
          root,
          enabledUsers: ["alice"],
          forbiddenRoots: [root],
        }),
      /forge-unavailable/u,
    );
    assert.throws(
      () =>
        createForgeCatalog({
          root,
          enabledUsers: ["alice"],
          forbiddenRoots: [join(root, "prompt-stacks")],
        }),
      /forge-unavailable/u,
    );
  } finally {
    rmSync(link, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog rendering uses the current supplied model, date, and tool subset", () => {
  const root = makeRoot();
  try {
    writeFileSync(
      join(root, "prompt-stacks", "welcome.json"),
      stack(
        "{{runtime.date}} {{runtime.activeModel}} {{runtime.selectedToolsText}}",
      ),
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, "agent-profiles", "writer.json"),
      profile("writer"),
      { mode: 0o600 },
    );
    const catalog = createForgeCatalog({ root, enabledUsers: ["alice"] });
    const result = catalog.resolve(
      { kind: "profile", id: "writer" },
      {
        now: new Date("2030-05-06T12:00:00Z"),
        activeTools: ["read"],
        model: { provider: "override", id: "current" },
      },
    );
    assert.match(result.systemPrompt, /2030/u);
    assert.match(result.systemPrompt, /override/u);
    assert.match(result.systemPrompt, /current/u);
    assert.match(result.systemPrompt, /read/u);
    assert.doesNotMatch(result.systemPrompt, /operator\/model/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
