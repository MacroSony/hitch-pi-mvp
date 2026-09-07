import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HitchApplication } from "../src/app/application.js";
import { HitchStore, type IdSource } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import {
  openFoundationDatabase,
  type Clock,
} from "../src/foundation/database.js";
import type {
  ForgeCatalog,
  ForgeResolved,
  ForgeResourceSummary,
  ForgeSelection,
} from "../src/forge/types.js";
import {
  FakeAgentRuntime,
  type RuntimeModel,
  type RuntimeTurn,
} from "../src/runtime/runtime.js";

class Sequence implements IdSource, Clock {
  #value = 0;

  public next(kind: "session" | "pi" | "turn" | "outbox"): string {
    this.#value += 1;
    return `${kind}_${String(this.#value).padStart(8, "0")}`;
  }

  public now(): number {
    this.#value += 1;
    return this.#value;
  }
}

class FakeForgeCatalog implements ForgeCatalog {
  readonly #enabledUsers: Set<string>;
  readonly #presets: Map<string, ForgeResolved>;
  readonly #profiles: Map<string, ForgeResolved>;

  public constructor(options?: {
    enabledUsers?: string[];
    presets?: ForgeResolved[];
    profiles?: ForgeResolved[];
  }) {
    this.#enabledUsers = new Set(options?.enabledUsers ?? ["alice", "bob"]);
    this.#presets = new Map(
      (options?.presets ?? []).map((p) => [p.selection.id, p]),
    );
    this.#profiles = new Map(
      (options?.profiles ?? []).map((p) => [p.selection.id, p]),
    );
  }

  public isEnabled(userId: string): boolean {
    return this.#enabledUsers.has(userId);
  }

  public list(kind: "preset" | "profile"): readonly ForgeResourceSummary[] {
    const map = kind === "preset" ? this.#presets : this.#profiles;
    return Array.from(map.values()).map((item) => ({
      kind,
      id: item.selection.id,
      name: item.name,
    }));
  }

  public resolve(selection: ForgeSelection): ForgeResolved {
    const map = selection.kind === "preset" ? this.#presets : this.#profiles;
    const found = map.get(selection.id);
    if (found === undefined) {
      throw new Error(`Resource '${selection.id}' not found`);
    }
    return found;
  }
}

const TEST_MODELS: readonly RuntimeModel[] = [
  {
    provider: "anthropic",
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    reasoning: true,
    input: ["text", "image"],
    thinkingLevels: ["off", "low", "medium", "high"],
  },
  {
    provider: "openai",
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: false,
    input: ["text", "image"],
    thinkingLevels: ["off"],
  },
];

const TEST_PRESETS: ForgeResolved[] = [
  {
    selection: { kind: "preset", id: "code-review" },
    name: "Code Review Assistant",
    mode: "append",
    systemPrompt: "You are a code review assistant.",
    tools: { allow: ["read", "grep"] },
  },
  {
    selection: { kind: "preset", id: "minimal" },
    name: "Minimal",
    mode: "replace",
    systemPrompt: "Be concise.",
  },
];

const TEST_PROFILES: ForgeResolved[] = [
  {
    selection: { kind: "profile", id: "senior-dev" },
    name: "Senior Developer",
    mode: "replace",
    systemPrompt: "You are a senior software architect.",
    model: { provider: "anthropic", id: "claude-3-7-sonnet" },
    thinkingLevel: "high",
  },
  {
    selection: { kind: "profile", id: "fast-helper" },
    name: "Fast Helper",
    mode: "prepend",
    systemPrompt: "Quick answers only.",
    model: { provider: "openai", id: "gpt-4o" },
    thinkingLevel: "off",
  },
  {
    selection: { kind: "profile", id: "prompt-only-profile" },
    name: "Prompt Only Profile",
    mode: "replace",
    systemPrompt: "Custom prompt without overriding model.",
  },
  {
    selection: { kind: "profile", id: "invalid-model-profile" },
    name: "Invalid Model Profile",
    mode: "replace",
    systemPrompt: "Profile with unknown model.",
    model: { provider: "nonexistent", id: "ghost-model" },
  },
  {
    selection: { kind: "profile", id: "invalid-thinking-profile" },
    name: "Invalid Thinking Profile",
    mode: "replace",
    systemPrompt: "Profile with unsupported thinking level.",
    model: { provider: "openai", id: "gpt-4o" },
    thinkingLevel: "high",
  },
];

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function setup(forgeCatalog?: ForgeCatalog) {
  const root = mkdtempSync(join(tmpdir(), "hitch-forge-test-"));
  chmodSync(root, 0o700);
  const paths = {
    dataRoot: join(root, "data"),
    piProfileDir: join(root, "pi"),
    wechat: join(root, "wechat"),
    alice: join(root, "alice"),
    bob: join(root, "bob"),
  };
  for (const path of [paths.piProfileDir, paths.wechat, paths.alice, paths.bob])
    privateDirectory(path);
  const config = parseConfig({
    schemaVersion: 1,
    dataRoot: paths.dataRoot,
    piProfileDir: paths.piProfileDir,
    minimumFreeBytes: 0,
    telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_TEST_TOKEN" }],
    wechatAccounts: [{ id: "primary", stateDir: paths.wechat }],
    users: [
      {
        id: "alice",
        workspace: paths.alice,
        telegram: { account: "primary", userId: "101", privateChatId: "101" },
      },
      {
        id: "bob",
        workspace: paths.bob,
        telegram: { account: "primary", userId: "202", privateChatId: "202" },
      },
    ],
  });
  const foundation = bootstrapFoundation(config);
  const sequence = new Sequence();
  const store = new HitchStore(foundation.database, sequence, sequence);
  const catalog =
    forgeCatalog ??
    new FakeForgeCatalog({
      enabledUsers: ["alice", "bob"],
      presets: TEST_PRESETS,
      profiles: TEST_PROFILES,
    });
  return { foundation, store, paths, sequence, catalog, config };
}

function update(
  updateId: number,
  userId: string,
  text: string,
  options: { chatId?: string; chatType?: string } = {},
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      chat: {
        id: options.chatId ?? userId,
        type: options.chatType ?? "private",
      },
      from: { id: userId },
      text,
    },
  };
}

test("two users with multiple sessions can list, preview, use, check status, and clear forge selections independently", () => {
  const env = setup();
  const runtime = new FakeAgentRuntime(undefined, TEST_MODELS, env.catalog);
  const app = new HitchApplication(env.store, runtime);
  app.start();

  // Alice checks initial preset and profile status
  assert.equal(
    app.receiveTelegram("primary", update(1, "101", "!preset")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(2, "101", "!profile status"))
      .accepted,
    true,
  );

  let outbox = env.store
    .pendingTelegramOutbox("primary")
    .map((o) => o.text ?? "");
  assert.ok(outbox.some((t) => t.includes("No preset selected.")));
  assert.ok(outbox.some((t) => t.includes("No profile selected.")));

  // Alice lists presets and profiles
  assert.equal(
    app.receiveTelegram("primary", update(3, "101", "!preset list")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(4, "101", "!profile list")).accepted,
    true,
  );
  outbox = env.store.pendingTelegramOutbox("primary").map((o) => o.text ?? "");
  assert.ok(
    outbox.some((t) => t.includes("code-review - Code Review Assistant")),
  );
  assert.ok(outbox.some((t) => t.includes("senior-dev - Senior Developer")));

  // Alice previews a preset and a profile
  assert.equal(
    app.receiveTelegram(
      "primary",
      update(5, "101", "!preset preview code-review"),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram(
      "primary",
      update(6, "101", "!profile preview senior-dev"),
    ).accepted,
    true,
  );
  outbox = env.store.pendingTelegramOutbox("primary").map((o) => o.text ?? "");
  assert.ok(
    outbox.some((t) =>
      t.includes("Preset: Code Review Assistant (code-review)"),
    ),
  );
  assert.ok(
    outbox.some((t) => t.includes("Profile: Senior Developer (senior-dev)")),
  );
  assert.ok(
    outbox.some((t) => t.includes("Model: anthropic/claude-3-7-sonnet")),
  );

  // Alice uses preset on session 1
  assert.equal(
    app.receiveTelegram("primary", update(7, "101", "!preset use code-review"))
      .accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(8, "101", "!preset status")).accepted,
    true,
  );

  // Alice creates session 2 and uses profile
  assert.equal(
    app.receiveTelegram("primary", update(9, "101", "!new work")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram(
      "primary",
      update(10, "101", "!profile use fast-helper"),
    ).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(11, "101", "!profile status"))
      .accepted,
    true,
  );

  // Bob (user 202) on primary endpoint operates independently
  assert.equal(
    app.receiveTelegram("primary", update(12, "202", "!preset status"))
      .accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(13, "202", "!profile use senior-dev"))
      .accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(14, "202", "!profile status"))
      .accepted,
    true,
  );

  // Switch Alice back to session-1 and check preset is preserved
  assert.equal(
    app.receiveTelegram("primary", update(15, "101", "!switch session-1"))
      .accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(16, "101", "!preset status"))
      .accepted,
    true,
  );

  // Alice clears preset on session-1
  assert.equal(
    app.receiveTelegram("primary", update(17, "101", "!preset clear")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(18, "101", "!preset status"))
      .accepted,
    true,
  );

  outbox = env.store
    .pendingTelegramOutbox("primary", 50)
    .map((o) => o.text ?? "");
  assert.ok(outbox.some((t) => t.includes("Selected preset code-review.")));
  assert.ok(outbox.some((t) => t.includes("Selected profile fast-helper.")));
  assert.ok(outbox.some((t) => t.includes("Selected profile senior-dev.")));
  assert.ok(outbox.some((t) => t.includes("Cleared preset selection.")));

  env.foundation.close();
});

test("database reopen preserves forge selections across sessions and users", () => {
  const env = setup();
  const runtime = new FakeAgentRuntime(undefined, TEST_MODELS, env.catalog);
  const app = new HitchApplication(env.store, runtime);
  app.start();

  // Set Alice selection to preset code-review
  assert.equal(
    app.receiveTelegram("primary", update(1, "101", "!preset use code-review"))
      .accepted,
    true,
  );
  // Set Bob selection to profile senior-dev
  assert.equal(
    app.receiveTelegram("primary", update(2, "202", "!profile use senior-dev"))
      .accepted,
    true,
  );
  env.foundation.close();

  // Reopen DB
  const reopenedDb = openFoundationDatabase(env.paths.dataRoot);
  const sequence = new Sequence();
  const reopenedStore = new HitchStore(reopenedDb, sequence, sequence);

  // Submit prompts from Alice and Bob
  const aliceTurnResult = reopenedStore.admitPrompt(
    {
      endpoint: reopenedStore.resolveTelegramEndpoint("primary", "101", "101")!,
      idempotencyKey: "alice-p1",
      contentDigest: "d1",
    },
    "hello from alice",
  );
  assert.equal(aliceTurnResult.duplicate, false);

  const bobTurnResult = reopenedStore.admitPrompt(
    {
      endpoint: reopenedStore.resolveTelegramEndpoint("primary", "202", "202")!,
      idempotencyKey: "bob-p1",
      contentDigest: "d2",
    },
    "hello from bob",
  );
  assert.equal(bobTurnResult.duplicate, false);

  // Claim next turn for Alice and Bob and verify forgeSelection was preserved
  const aliceClaimed = reopenedStore.claimNextTurn("alice");
  assert.ok(aliceClaimed !== null);
  assert.deepEqual(aliceClaimed.forgeSelection, {
    kind: "preset",
    id: "code-review",
  });

  const bobClaimed = reopenedStore.claimNextTurn("bob");
  assert.ok(bobClaimed !== null);
  assert.deepEqual(bobClaimed.forgeSelection, {
    kind: "profile",
    id: "senior-dev",
  });
  assert.equal(bobClaimed.modelProvider, "anthropic");
  assert.equal(bobClaimed.modelId, "claude-3-7-sonnet");
  assert.equal(bobClaimed.thinkingLevel, "high");

  reopenedDb.close();
});

test("duplicate command messages are idempotent and do not alter state", () => {
  const env = setup();
  const runtime = new FakeAgentRuntime(undefined, TEST_MODELS, env.catalog);
  const app = new HitchApplication(env.store, runtime);
  app.start();

  const msg = update(10, "101", "!profile use fast-helper");
  const first = app.receiveTelegram("primary", msg);
  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, false);

  // Re-send exact same update (idempotency key matches)
  const second = app.receiveTelegram("primary", msg);
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true);

  env.foundation.close();
});

test("changing forge selection is rejected when turn is active or queued (busy check)", () => {
  const env = setup();
  const calls: RuntimeTurn[] = [];
  let finishTurn: () => void = () => {};
  const runtime = new FakeAgentRuntime(
    (turn) =>
      new Promise((resolve) => {
        calls.push(turn);
        finishTurn = () =>
          resolve({
            outcome: "succeeded",
            text: "done",
            sessionReusable: true,
          });
      }),
    TEST_MODELS,
    env.catalog,
  );
  const app = new HitchApplication(env.store, runtime);
  app.start();

  // Send a prompt to start an active turn
  assert.equal(
    app.receiveTelegram("primary", update(1, "101", "run some long task"))
      .accepted,
    true,
  );

  // Also queue a second prompt
  assert.equal(
    app.receiveTelegram("primary", update(2, "101", "second prompt")).accepted,
    true,
  );

  // Try modifying forge selection while turns are running / queued
  const rejectPresetUse = app.receiveTelegram(
    "primary",
    update(3, "101", "!preset use code-review"),
  );
  assert.equal(rejectPresetUse.accepted, false);
  assert.equal(rejectPresetUse.category, "busy");

  const rejectPresetClear = app.receiveTelegram(
    "primary",
    update(4, "101", "!preset clear"),
  );
  assert.equal(rejectPresetClear.accepted, false);
  assert.equal(rejectPresetClear.category, "busy");

  const rejectProfileUse = app.receiveTelegram(
    "primary",
    update(5, "101", "!profile use senior-dev"),
  );
  assert.equal(rejectProfileUse.accepted, false);
  assert.equal(rejectProfileUse.category, "busy");

  const rejectProfileClear = app.receiveTelegram(
    "primary",
    update(6, "101", "!profile clear"),
  );
  assert.equal(rejectProfileClear.accepted, false);
  assert.equal(rejectProfileClear.category, "busy");

  // Read-only status and preview should still be allowed during busy
  const allowStatus = app.receiveTelegram(
    "primary",
    update(7, "101", "!preset status"),
  );
  assert.equal(allowStatus.accepted, true);

  const allowPreview = app.receiveTelegram(
    "primary",
    update(8, "101", "!preset preview code-review"),
  );
  assert.equal(allowPreview.accepted, true);

  // Complete turns
  finishTurn();

  env.foundation.close();
});

test("profile use with invalid model or thinking level fails atomically without modifying state", () => {
  const env = setup();
  const runtime = new FakeAgentRuntime(undefined, TEST_MODELS, env.catalog);
  const app = new HitchApplication(env.store, runtime);
  app.start();

  // Set explicit initial model on session
  assert.equal(
    app.receiveTelegram(
      "primary",
      update(1, "101", "!model anthropic/claude-3-7-sonnet"),
    ).accepted,
    true,
  );

  // Attempt to use a profile with an invalid model
  const badModel = app.receiveTelegram(
    "primary",
    update(2, "101", "!profile use invalid-model-profile"),
  );
  assert.equal(badModel.accepted, false);
  assert.equal(badModel.category, "model-unavailable");

  // Verify status: no profile selected, model still claude-3-7-sonnet
  assert.equal(
    app.receiveTelegram("primary", update(3, "101", "!profile status"))
      .accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(4, "101", "!status")).accepted,
    true,
  );

  // Attempt to use a profile with unsupported thinking level
  const badThinking = app.receiveTelegram(
    "primary",
    update(5, "101", "!profile use invalid-thinking-profile"),
  );
  assert.equal(badThinking.accepted, false);
  assert.equal(badThinking.category, "model-unavailable");

  // Verify status remains unchanged
  assert.equal(
    app.receiveTelegram("primary", update(6, "101", "!profile status"))
      .accepted,
    true,
  );

  const outbox = env.store
    .pendingTelegramOutbox("primary")
    .map((o) => o.text ?? "");
  assert.ok(outbox.some((t) => t.includes("anthropic/claude-3-7-sonnet")));
  assert.ok(outbox.some((t) => t.includes("No profile selected.")));

  env.foundation.close();
});

test("disabled user receives rejected on all preset and profile operations without leaking data", () => {
  // Catalog where Bob is disabled
  const catalog = new FakeForgeCatalog({
    enabledUsers: ["alice"],
    presets: TEST_PRESETS,
    profiles: TEST_PROFILES,
  });
  const env = setup(catalog);
  const runtime = new FakeAgentRuntime(undefined, TEST_MODELS, catalog);
  const app = new HitchApplication(env.store, runtime);
  app.start();

  // Bob tries all preset/profile commands
  const commands = [
    "!preset",
    "!preset list",
    "!preset preview code-review",
    "!preset use code-review",
    "!preset clear",
    "!profile",
    "!profile list",
    "!profile preview senior-dev",
    "!profile use senior-dev",
    "!profile clear",
  ];

  for (const [idx, cmd] of commands.entries()) {
    const res = app.receiveTelegram("primary", update(100 + idx, "202", cmd));
    assert.equal(
      res.accepted,
      false,
      `Expected ${cmd} to be rejected for disabled user`,
    );
    assert.equal(res.category, "rejected");
  }

  // Alice (enabled) can still list and use
  assert.equal(
    app.receiveTelegram("primary", update(200, "101", "!preset list")).accepted,
    true,
  );

  env.foundation.close();
});

test("profile use applies model once and subsequent explicit !model/!thinking remain authoritative across turns", async () => {
  const env = setup();
  const claimedTurns: RuntimeTurn[] = [];
  const runtime = new FakeAgentRuntime(
    (turn) => {
      claimedTurns.push(turn);
      return {
        outcome: "succeeded",
        text: `Echo: ${turn.prompt}`,
        sessionReusable: true,
      };
    },
    TEST_MODELS,
    env.catalog,
  );
  const app = new HitchApplication(env.store, runtime);
  app.start();

  // 1. Profile use sets model to gpt-4o
  assert.equal(
    app.receiveTelegram("primary", update(1, "101", "!profile use fast-helper"))
      .accepted,
    true,
  );

  // 2. Submit prompt and check claimed turn has profile and gpt-4o
  assert.equal(
    app.receiveTelegram("primary", update(2, "101", "first prompt")).accepted,
    true,
  );
  await app.drain();

  // 3. User explicitly switches model to claude-3-7-sonnet
  assert.equal(
    app.receiveTelegram(
      "primary",
      update(3, "101", "!model anthropic/claude-3-7-sonnet"),
    ).accepted,
    true,
  );

  // 4. Submit next prompt - profile is still fast-helper, but model is claude-3-7-sonnet (not clobbered by profile)
  assert.equal(
    app.receiveTelegram("primary", update(4, "101", "second prompt")).accepted,
    true,
  );
  await app.drain();

  // 5. User switches to preset code-review - model remains claude-3-7-sonnet
  assert.equal(
    app.receiveTelegram("primary", update(5, "101", "!preset use code-review"))
      .accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(6, "101", "third prompt")).accepted,
    true,
  );
  await app.drain();

  // 6. User clears preset - model remains claude-3-7-sonnet, forgeSelection is cleared
  assert.equal(
    app.receiveTelegram("primary", update(7, "101", "!preset clear")).accepted,
    true,
  );
  assert.equal(
    app.receiveTelegram("primary", update(8, "101", "fourth prompt")).accepted,
    true,
  );
  await app.drain();

  assert.equal(claimedTurns.length, 4);
  const [turn1, turn2, turn3, turn4] = claimedTurns;
  assert.ok(
    turn1 !== undefined &&
      turn2 !== undefined &&
      turn3 !== undefined &&
      turn4 !== undefined,
  );

  // Turn 1: fast-helper profile + gpt-4o model
  assert.deepEqual(turn1.forgeSelection, {
    kind: "profile",
    id: "fast-helper",
  });
  assert.equal(turn1.modelProvider, "openai");
  assert.equal(turn1.modelId, "gpt-4o");

  // Turn 2: fast-helper profile + explicitly chosen claude model
  assert.deepEqual(turn2.forgeSelection, {
    kind: "profile",
    id: "fast-helper",
  });
  assert.equal(turn2.modelProvider, "anthropic");
  assert.equal(turn2.modelId, "claude-3-7-sonnet");

  // Turn 3: code-review preset + claude model
  assert.deepEqual(turn3.forgeSelection, { kind: "preset", id: "code-review" });
  assert.equal(turn3.modelProvider, "anthropic");
  assert.equal(turn3.modelId, "claude-3-7-sonnet");

  // Turn 4: no forge selection + claude model
  assert.equal(turn4.forgeSelection, undefined);
  assert.equal(turn4.modelProvider, "anthropic");
  assert.equal(turn4.modelId, "claude-3-7-sonnet");

  env.foundation.close();
});

test("strict ID validation rejects paths, control chars, and excessively long IDs", () => {
  const env = setup();
  const runtime = new FakeAgentRuntime(undefined, TEST_MODELS, env.catalog);
  const app = new HitchApplication(env.store, runtime);
  app.start();

  const invalidInputs = [
    "!preset use ../secret",
    "!preset use /etc/passwd",
    "!preset use foo\\bar",
    "!preset use " + "a".repeat(65),
    "!profile preview ../bad",
    "!preset use foo bar",
    "!preset use",
  ];

  for (const [idx, cmd] of invalidInputs.entries()) {
    const res = app.receiveTelegram("primary", update(300 + idx, "101", cmd));
    assert.equal(res.accepted, false, `Expected ${cmd} to be rejected`);
    assert.equal(res.category, "rejected");
  }

  env.foundation.close();
});

test("clearing the other Forge kind does not remove the selected resource", () => {
  const env = setup();
  const app = new HitchApplication(
    env.store,
    new FakeAgentRuntime(undefined, TEST_MODELS, env.catalog),
  );
  try {
    for (const [id, command] of [
      [1, "!preset use minimal"],
      [2, "!profile clear"],
      [3, "!preset status"],
      [4, "!profile use senior-dev"],
      [5, "!preset clear"],
      [6, "!profile status"],
    ] as const) {
      assert.equal(
        app.receiveTelegram("primary", update(id, "101", command)).accepted,
        true,
      );
    }
    const texts = env.store
      .pendingTelegramOutbox("primary")
      .map((item) => item.text);
    assert.ok(texts.includes("Selected preset: minimal."));
    assert.ok(texts.includes("Selected profile: senior-dev."));
  } finally {
    app.stop();
    env.foundation.close();
  }
});
