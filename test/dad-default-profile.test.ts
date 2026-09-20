import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { HitchApplication } from "../src/app/application.js";
import { HitchStore } from "../src/app/store.js";
import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";
import { createForgeCatalog } from "../src/forge/catalog.js";
import { preflightNativeModel } from "../src/pi/native-runtime.js";
import {
  FakeAgentRuntime,
  type RuntimeModel,
  type RuntimeTurn,
} from "../src/runtime/runtime.js";

class Sequence {
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

const MODELS: readonly RuntimeModel[] = [
  {
    provider: "synthetic",
    id: "dad-model",
    name: "Synthetic Dad Model",
    reasoning: true,
    input: ["text"],
    thinkingLevels: ["off", "medium"],
  },
  {
    provider: "synthetic",
    id: "alt-model",
    name: "Synthetic Alternate Model",
    reasoning: true,
    input: ["text"],
    thinkingLevels: ["off", "low"],
  },
  {
    provider: "synthetic",
    id: "manual-model",
    name: "Synthetic Manual Model",
    reasoning: false,
    input: ["text"],
    thinkingLevels: ["off", "high"],
  },
];

const BASELINE_TOOLS = [
  "bash",
  "edit",
  "find",
  "grep",
  "hitch_publish",
  "ls",
  "read",
  "write",
];

function documentRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(join(root, "prompt-stacks"), { mode: 0o700 });
  mkdirSync(join(root, "agent-profiles"), { mode: 0o700 });
}

function writeForgeFixture(root: string): void {
  writeFileSync(
    join(root, "prompt-stacks", "stock-research-dad-stack.json"),
    JSON.stringify({
      schemaVersion: 1,
      type: "pi-forge.prompt-stack",
      id: "stock-research-dad-stack",
      name: "Synthetic Stock Research Dad",
      mode: "replace",
      tools: { allow: ["read", "mcp*"] },
      items: [
        {
          kind: "block",
          id: "persona",
          role: "system",
          content:
            "Synthetic stock-research dad persona. No personal watchlists or personal material. active={{ runtime.selectedToolsText }} model={{ runtime.activeModel }} cwd={{ runtime.cwd }}",
        },
      ],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "prompt-stacks", "stock-research-preset.json"),
    JSON.stringify({
      schemaVersion: 1,
      type: "pi-forge.prompt-stack",
      id: "stock-research-preset",
      name: "Synthetic Preset",
      mode: "replace",
      tools: { allow: ["grep"] },
      items: [
        {
          kind: "block",
          id: "preset",
          role: "system",
          content:
            "Synthetic preset only. active={{ runtime.selectedToolsText }}",
        },
      ],
    }),
    { mode: 0o600 },
  );
  for (const [id, model, stack] of [
    ["stock-research-dad", "dad-model", "stock-research-dad-stack"],
    ["stock-research-dad-alt", "alt-model", "stock-research-dad-stack"],
  ] as const) {
    writeFileSync(
      join(root, "agent-profiles", `${id}.json`),
      JSON.stringify({
        schemaVersion: 1,
        type: "pi-forge.agent-profile",
        id,
        name: id,
        model: { provider: "synthetic", id: model },
        thinkingLevel: model === "dad-model" ? "medium" : "low",
        promptStack: stack,
      }),
      { mode: 0o600 },
    );
  }
}

function update(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      chat: { id: "101", type: "private" },
      from: { id: "101" },
      text,
    },
  };
}

function isPreflightFailure(value: unknown): value is { outcome: string } {
  return value !== null && typeof value === "object" && "outcome" in value;
}

test("configured dad default flows through main mapping, claim, Forge compile, and clear fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-dad-default-"));
  chmodSync(root, 0o700);
  const forgeRoot = join(root, "forge");
  documentRoot(forgeRoot);
  writeForgeFixture(forgeRoot);
  const paths = {
    dataRoot: join(root, "data"),
    piProfileDir: join(root, "pi-profile"),
    workspace: join(root, "workspace"),
    wechat: join(root, "wechat"),
  };
  for (const path of [paths.piProfileDir, paths.workspace, paths.wechat]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }

  const config = parseConfig({
    schemaVersion: 1,
    dataRoot: paths.dataRoot,
    piProfileDir: paths.piProfileDir,
    minimumFreeBytes: 0,
    telegramAccounts: [{ id: "primary", botTokenEnv: "HITCH_TEST_TOKEN" }],
    wechatAccounts: [{ id: "primary", stateDir: paths.wechat }],
    users: [
      {
        id: "dad",
        workspace: paths.workspace,
        forgeProfile: "stock-research-dad",
        telegram: { account: "primary", userId: "101", privateChatId: "101" },
      },
    ],
    forge: { root: forgeRoot, enabledUsers: ["dad"] },
  });
  const foundation = bootstrapFoundation(config);
  const forge = createForgeCatalog({
    root: forgeRoot,
    enabledUsers: config.forge?.enabledUsers ?? [],
  });
  // This is the composition-root mapping in main.ts, exercised against the
  // real config and then handed to the real store (not a fake default lookup).
  const forgeDefaults = new Map(
    config.users
      .filter((user) => user.forgeProfile !== undefined)
      .map((user) => [
        user.id,
        { kind: "profile" as const, id: user.forgeProfile as string },
      ]),
  );
  assert.deepEqual(forgeDefaults.get("dad"), {
    kind: "profile",
    id: "stock-research-dad",
  });

  const sequence = new Sequence();
  const store = new HitchStore(
    foundation.database,
    sequence,
    sequence,
    undefined,
    forgeDefaults,
  );
  const observed: Array<{
    turn: RuntimeTurn;
    model: string;
    thinking: string;
    activeTools: readonly string[];
    prompt: string;
    forge: { kind: string; id: string } | undefined;
  }> = [];
  const runtime = new FakeAgentRuntime(
    (turn) => {
      const compiled = preflightNativeModel(
        MODELS,
        turn,
        "dad",
        forge,
        BASELINE_TOOLS,
      );
      assert.equal(isPreflightFailure(compiled), false);
      if (isPreflightFailure(compiled))
        return {
          outcome: "failed",
          text: "",
          error: "preflight",
          sessionReusable: true,
        };
      assert.ok(compiled.forge);
      observed.push({
        turn,
        model: `${compiled.model.provider}/${compiled.model.id}`,
        thinking: compiled.thinkingLevel,
        activeTools: compiled.activeTools,
        prompt: compiled.forge.systemPrompt,
        forge: compiled.forge.selection,
      });
      return {
        outcome: "succeeded",
        text: "synthetic pass",
        sessionReusable: true,
      };
    },
    MODELS,
    forge,
  );
  const app = new HitchApplication(store, runtime);
  app.start();
  try {
    const commands = [
      [1, "first prompt uses the configured default"],
      [2, "!model synthetic/manual-model"],
      [3, "second prompt keeps default persona but explicit model"],
      [4, "!profile use stock-research-dad-alt"],
      [5, "third prompt uses explicit profile"],
      [6, "!profile clear"],
      [7, "fourth prompt returns to configured default"],
      [8, "!preset use stock-research-preset"],
      [9, "fifth prompt uses explicit preset"],
      [10, "!preset clear"],
      [11, "sixth prompt returns to configured default again"],
    ] as const;
    for (const [id, text] of commands) {
      const result = app.receiveTelegram("primary", update(id, text));
      assert.equal(result.accepted, true, text);
      if (!text.startsWith("!")) await app.drain();
    }

    assert.equal(observed.length, 6);
    const [first, second, third, fourth, fifth, sixth] = observed;
    assert.ok(first && second && third && fourth && fifth && sixth);

    // No !profile was needed: the default is attached at claim time and is
    // compiled by the real native preflight path.
    assert.deepEqual(first.forge, {
      kind: "profile",
      id: "stock-research-dad",
    });
    assert.equal(first.model, "synthetic/dad-model");
    assert.equal(first.thinking, "medium");
    assert.deepEqual(first.activeTools, ["read"]);
    assert.match(first.prompt, /Synthetic stock-research dad persona/u);
    assert.match(first.prompt, /model=synthetic\/dad-model/u);

    // A session model is authoritative over the default profile's model.
    assert.deepEqual(second.forge, {
      kind: "profile",
      id: "stock-research-dad",
    });
    assert.equal(second.model, "synthetic/manual-model");
    assert.deepEqual(second.activeTools, ["read"]);
    assert.match(second.prompt, /model=synthetic\/manual-model/u);

    // Explicit profile and then clear: the clear removes only persisted
    // selection; the configured fallback returns on the next claimed Turn.
    assert.deepEqual(third.forge, {
      kind: "profile",
      id: "stock-research-dad-alt",
    });
    assert.equal(third.model, "synthetic/alt-model");
    assert.deepEqual(fourth.forge, {
      kind: "profile",
      id: "stock-research-dad",
    });
    assert.equal(fourth.model, "synthetic/alt-model");

    // Preset selection wins over the default too, while its policy reduces the
    // static baseline. Clearing it restores the default profile and does not
    // write the fallback into sessions.
    assert.deepEqual(fifth.forge, {
      kind: "preset",
      id: "stock-research-preset",
    });
    assert.equal(fifth.model, "synthetic/alt-model");
    assert.deepEqual(fifth.activeTools, ["grep"]);
    assert.deepEqual(sixth.forge, {
      kind: "profile",
      id: "stock-research-dad",
    });
    assert.equal(sixth.model, "synthetic/alt-model");
    assert.deepEqual(sixth.activeTools, ["read"]);

    const session = foundation.database.connection
      .prepare(
        "SELECT forge_kind, forge_id, model_provider, model_id FROM sessions WHERE user_id = ?",
      )
      .get("dad") as {
      forge_kind: string | null;
      forge_id: string | null;
      model_provider: string | null;
      model_id: string | null;
    };
    assert.equal(session.forge_kind, null);
    assert.equal(session.forge_id, null);
    assert.equal(session.model_provider, "synthetic");
    assert.equal(session.model_id, "alt-model");
  } finally {
    app.stop();
    foundation.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp dynamic-source exemption is path-based, while Forge mcp* cannot add tools", () => {
  const repository =
    process.env.HITCH_REPO_ROOT ??
    join(dirname(fileURLToPath(import.meta.url)), "../..");
  const runtimeSource = readFileSync(
    join(repository, "src", "pi", "native-runtime.ts"),
    "utf8",
  );
  const attestationSource = readFileSync(
    join(
      repository,
      "packages",
      "hitch-sandbox-extension",
      "manifest-attest.mjs",
    ),
    "utf8",
  );
  const sandboxSource = readFileSync(
    join(repository, "packages", "hitch-sandbox-extension", "hitch-sandbox.ts"),
    "utf8",
  );
  const mcpSource = readFileSync(
    join(repository, "packages", "hitch-sandbox-extension", "hitch-mcp.ts"),
    "utf8",
  );

  assert.match(runtimeSource, /HITCH_DYNAMIC_EXTENSION_PATHS/u);
  assert.match(runtimeSource, /mcpEnabled \? \[mcpExtension\] : \[\]/u);
  assert.match(
    runtimeSource,
    /const mcpExtension = join\(this.#assets, "hitch-mcp\.ts"\)/u,
  );
  assert.match(runtimeSource, /HITCH_MCP_ADAPTER_PATH/u);
  assert.match(runtimeSource, /HITCH_MCP_ADAPTER_SHA256/u);
  assert.match(runtimeSource, /HITCH_MCP_CONFIG_PATH/u);
  assert.match(runtimeSource, /validateMcpAdapterFile/u);
  assert.match(runtimeSource, /validatePrivateMcpConfigFile/u);
  assert.match(runtimeSource, /0o022n/u);
  assert.match(runtimeSource, /0o077n/u);
  assert.match(
    runtimeSource,
    /validateMcpAdapterFile\(mcpAdapter, "adapter", 8 \* 1024 \* 1024\)/u,
  );
  assert.match(
    runtimeSource,
    /validatePrivateMcpConfigFile\(\s*profileMcpConfig,/u,
  );
  assert.match(
    attestationSource,
    /tool\.path.*dynamicPaths\.has\(tool\.path\)/su,
  );
  assert.match(attestationSource, /never route through the sandboxed execute/u);
  assert.match(sandboxSource, /Dynamic-source tools.*excluded from/u);
  assert.match(mcpSource, /createMcpAdapter/u);
  assert.match(mcpSource, /safeGatewayParameters/u);
  assert.match(mcpSource, /return policyAllows\(name, policy\)/u);
  assert.doesNotMatch(mcpSource, /mcp_\$\{name\}/u);
  assert.match(mcpSource, /mcpScript.*disabled/u);
  assert.match(mcpSource, /registerCommand.*undefined/u);
  assert.match(mcpSource, /MCP management actions are disabled/u);

  // This is the actual policy reduction used by native preflight. A wildcard
  // for a not-yet-registered mcp tool cannot enlarge Hitch's static baseline.
  const forgeRoot = mkdtempSync(join(tmpdir(), "hitch-dad-mcp-policy-"));
  chmodSync(forgeRoot, 0o700);
  documentRoot(forgeRoot);
  try {
    writeForgeFixture(forgeRoot);
    const catalog = createForgeCatalog({
      root: forgeRoot,
      enabledUsers: ["dad"],
    });
    const resolved = catalog.resolve({
      kind: "profile",
      id: "stock-research-dad",
    });
    assert.deepEqual(resolved.tools, { allow: ["read", "mcp*"] });
    const compiled = preflightNativeModel(
      MODELS,
      {
        turnId: "turn-2",
        userId: "dad",
        sessionId: "session-1",
        prompt: "synthetic",
        forgeSelection: { kind: "profile", id: "stock-research-dad" },
      },
      "dad",
      catalog,
      BASELINE_TOOLS,
    );
    assert.equal(isPreflightFailure(compiled), false);
    if (!isPreflightFailure(compiled))
      assert.deepEqual(compiled.activeTools, ["read"]);
  } finally {
    rmSync(forgeRoot, { recursive: true, force: true });
  }
});
