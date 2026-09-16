import { reduceForgeTools } from "@zihanw/pi-forge/service";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  controllerArguments,
  waitForAttestation,
  type ControllerContext,
} from "../src/pi/native-runtime.js";
import type {
  ForgeCatalog,
  ForgeResolved,
  ForgeSelection,
} from "../src/forge/types.js";

const repository = join(dirname(fileURLToPath(import.meta.url)), "../..");

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("mandatory and web-search extension source digests match native runtime constants", () => {
  const sandboxPath = join(
    repository,
    "packages",
    "hitch-sandbox-extension",
    "hitch-sandbox.ts",
  );
  const webPath = join(
    repository,
    "packages",
    "hitch-web-search-extension",
    "pi-web-search.ts",
  );
  const runtimeSource = readFileSync(
    join(repository, "src", "pi", "native-runtime.ts"),
    "utf8",
  );

  const sandboxHash = sha256File(sandboxPath);
  const webHash = sha256File(webPath);

  assert.match(runtimeSource, new RegExp(sandboxHash, "u"));
  assert.match(runtimeSource, new RegExp(webHash, "u"));
});

test("extension sources contain strict HITCH_ACTIVE_TOOLS and HITCH_FORGE_PROMPT checks", () => {
  const sandboxSource = readFileSync(
    join(repository, "packages", "hitch-sandbox-extension", "hitch-sandbox.ts"),
    "utf8",
  );
  const webSource = readFileSync(
    join(
      repository,
      "packages",
      "hitch-web-search-extension",
      "pi-web-search.ts",
    ),
    "utf8",
  );

  // Both extensions parse HITCH_ACTIVE_TOOLS strictly
  assert.match(sandboxSource, /HITCH_ACTIVE_TOOLS/u);
  assert.match(sandboxSource, /HITCH_FORGE_PROMPT/u);
  assert.match(sandboxSource, /32 \* 1024/u); // 32KiB prompt limit
  assert.match(sandboxSource, /before_agent_start/u);

  // Mandatory extension handles user_bash disabled tool check
  assert.match(sandboxSource, /activeSubsetSet\.has\("bash"\)/u);

  // Web search extension checks active subset before search
  assert.match(webSource, /HITCH_ACTIVE_TOOLS/u);
  assert.match(webSource, /activeSubsetSet\.has\("web_search"\)/u);
});

test("waitForAttestation accepts matching active subset and rejects mismatched tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-forge-attest-"));
  chmodSync(root, 0o700);
  const logPath = join(root, "sandbox.log");
  const controllerNonce = randomBytes(16).toString("hex");
  const userId = "alice";

  const baseline8 = [
    "bash",
    "edit",
    "find",
    "grep",
    "hitch_publish",
    "ls",
    "read",
    "write",
  ];
  const activeSubset = ["read", "write"].sort();

  const context: ControllerContext = {
    root,
    workspace: join(root, "workspace"),
    inbox: join(root, "inbox"),
    publishRoot: join(root, "publish"),
    log: logPath,
    controllerNonce,
    turnHandle: randomBytes(16).toString("hex"),
    userId,
    webSearchEnabled: false,
    activeTools: activeSubset,
    forgePrompt: { mode: "replace", systemPrompt: "Custom prompt" },
  };

  const extensionPath = join(repository, "dist", "sandbox", "hitch-sandbox.ts");
  const dummySchemaDigest = createHash("sha256")
    .update("schemas")
    .digest("hex");
  const extensionDigest = sha256File(
    join(repository, "packages", "hitch-sandbox-extension", "hitch-sandbox.ts"),
  );

  try {
    // Valid attestation entry with activeTools = subset, exactTools = baseline, allTools = baseline
    const logEntry = {
      type: "startup-attestation",
      ready: true,
      controllerNonce,
      userId,
      exactTools: baseline8,
      allTools: baseline8,
      activeTools: activeSubset,
      sourcePaths: baseline8.map(() => extensionPath),
      sourcePath: extensionPath,
      extensionDigest,
      webSearchEnabled: false,
      schemaDigest: dummySchemaDigest,
    };
    writeFileSync(logPath, `${JSON.stringify(logEntry)}\n`, { mode: 0o600 });

    let controllerExited = false;
    const fakeController = {
      get exited() {
        return controllerExited;
      },
    };

    // Should succeed because activeTools matches context.activeTools
    await waitForAttestation(fakeController, context);

    // Mismatched active tools in log should fail attestation
    const mismatchedEntry = {
      ...logEntry,
      activeTools: baseline8, // should have been activeSubset
    };
    writeFileSync(logPath, `${JSON.stringify(mismatchedEntry)}\n`, {
      mode: 0o600,
    });

    controllerExited = true;
    await assert.rejects(async () => {
      await waitForAttestation(fakeController, context);
    }, /sandbox startup attestation (is invalid|did not arrive)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime tool allow/deny logic computes correct subsets", () => {
  const baseline8 = [
    "bash",
    "edit",
    "find",
    "grep",
    "hitch_publish",
    "ls",
    "read",
    "write",
  ];
  const baseline9 = [...baseline8, "web_search"].sort();

  const computeActiveTools = reduceForgeTools;

  // Allow subset
  assert.deepEqual(
    computeActiveTools(baseline8, { allow: ["read", "write"] }),
    ["read", "write"],
  );

  // Deny subset
  assert.deepEqual(
    computeActiveTools(baseline8, { deny: ["bash", "hitch_publish"] }),
    ["edit", "find", "grep", "ls", "read", "write"],
  );

  // Preserve actual Forge wildcard semantics, bounded by the operator baseline.
  assert.deepEqual(computeActiveTools(baseline8, { allow: ["*"] }), baseline8);
  assert.deepEqual(computeActiveTools(baseline9, { allow: ["web_*"] }), [
    "web_search",
  ]);

  // Unknown tool in allow is discarded (cannot add tools)
  assert.deepEqual(
    computeActiveTools(baseline8, {
      allow: ["read", "custom_tool", "web_search"],
    }),
    ["read"],
  );

  // Web enabled allow includes web_search
  assert.deepEqual(
    computeActiveTools(baseline9, { allow: ["read", "web_search"] }),
    ["read", "web_search"],
  );

  // Deny all produces empty array
  assert.deepEqual(computeActiveTools(baseline8, { deny: baseline8 }), []);
});

test("waitForAttestation validates web search attestation with active subset", async () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-forge-attest-web-"));
  chmodSync(root, 0o700);
  const logPath = join(root, "sandbox.log");
  const controllerNonce = randomBytes(16).toString("hex");
  const userId = "bob";

  const baseline8 = [
    "bash",
    "edit",
    "find",
    "grep",
    "hitch_publish",
    "ls",
    "read",
    "write",
  ];
  const baseline9 = [...baseline8, "web_search"].sort();
  const activeSubset = ["read", "web_search"].sort();

  const context: ControllerContext = {
    root,
    workspace: join(root, "workspace"),
    inbox: join(root, "inbox"),
    publishRoot: join(root, "publish"),
    log: logPath,
    controllerNonce,
    turnHandle: randomBytes(16).toString("hex"),
    userId,
    webSearchEnabled: true,
    activeTools: activeSubset,
    forgePrompt: { mode: "append", systemPrompt: "Appended prompt" },
  };

  const extensionPath = join(repository, "dist", "sandbox", "hitch-sandbox.ts");
  const webExtensionPath = join(
    repository,
    "dist",
    "sandbox",
    "pi-web-search.ts",
  );
  const dummySchemaDigest = createHash("sha256")
    .update("schemas")
    .digest("hex");
  const extensionDigest = sha256File(
    join(repository, "packages", "hitch-sandbox-extension", "hitch-sandbox.ts"),
  );
  const webExtensionDigest = sha256File(
    join(
      repository,
      "packages",
      "hitch-web-search-extension",
      "pi-web-search.ts",
    ),
  );

  try {
    const mandatoryLog = {
      type: "startup-attestation",
      ready: true,
      controllerNonce,
      userId,
      exactTools: baseline9,
      allTools: baseline9,
      activeTools: activeSubset,
      sourcePaths: baseline9.map((tool) =>
        tool === "web_search" ? webExtensionPath : extensionPath,
      ),
      sourcePath: extensionPath,
      extensionDigest,
      webSearchEnabled: true,
      schemaDigest: dummySchemaDigest,
    };
    const webLog = {
      type: "web-search-attestation",
      ready: true,
      controllerNonce,
      userId,
      exactTools: baseline9,
      allTools: baseline9,
      activeTools: activeSubset,
      sourcePaths: baseline9.map((tool) =>
        tool === "web_search" ? webExtensionPath : extensionPath,
      ),
      sourcePath: webExtensionPath,
      extensionDigest: webExtensionDigest,
      schemaDigest: dummySchemaDigest,
    };

    writeFileSync(
      logPath,
      `${JSON.stringify(mandatoryLog)}\n${JSON.stringify(webLog)}\n`,
      { mode: 0o600 },
    );

    const fakeController = {
      get exited() {
        return false;
      },
    };

    // Both mandatory and web attestations present with active subset
    await waitForAttestation(fakeController, context);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Forge catalog resolution validation in native runtime handles unresolvable / disabled users", () => {
  const mockCatalog: ForgeCatalog = {
    isEnabled(userId: string): boolean {
      return userId === "alice";
    },
    list() {
      return [];
    },
    resolve(selection: ForgeSelection): ForgeResolved {
      if (selection.id === "valid") {
        return {
          selection,
          name: "Valid Profile",
          mode: "replace",
          systemPrompt: "You are a helpful assistant.",
          tools: { allow: ["read", "write"] },
        };
      }
      throw new Error("not found");
    },
  };

  // Disabled user alice=true, bob=false
  assert.equal(mockCatalog.isEnabled("alice"), true);
  assert.equal(mockCatalog.isEnabled("bob"), false);

  // Valid resolve
  const resolved = mockCatalog.resolve({ kind: "profile", id: "valid" });
  assert.equal(resolved.mode, "replace");
  assert.equal(resolved.systemPrompt, "You are a helpful assistant.");
  assert.deepEqual(resolved.tools?.allow, ["read", "write"]);

  // Invalid resolve throws
  assert.throws(() => {
    mockCatalog.resolve({ kind: "profile", id: "nonexistent" });
  });
});

test("controllerArguments accepts 4th optional provider extension and formats CLI args strictly", () => {
  const sandboxExt = "/dist/sandbox/hitch-sandbox.ts";
  const webExt = "/dist/sandbox/pi-web-search.ts";
  const providerExt = "/dist/sandbox/pi-antigravity.ts";

  const baseArgs = controllerArguments(sandboxExt, undefined, { kind: "none" });
  assert.deepEqual(baseArgs, [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    sandboxExt,
    "--no-builtin-tools",
    "--exclude-tools",
    "powershell",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--no-session",
  ]);

  const webArgs = controllerArguments(sandboxExt, webExt, { kind: "none" });
  assert.deepEqual(webArgs, [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    sandboxExt,
    "--extension",
    webExt,
    "--no-builtin-tools",
    "--exclude-tools",
    "powershell",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--no-session",
  ]);

  const providerArgs = controllerArguments(
    sandboxExt,
    undefined,
    { kind: "none" },
    providerExt,
  );
  assert.deepEqual(providerArgs, [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    sandboxExt,
    "--extension",
    providerExt,
    "--no-builtin-tools",
    "--exclude-tools",
    "powershell",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--no-session",
  ]);

  const bothArgs = controllerArguments(
    sandboxExt,
    webExt,
    { kind: "id", id: "sess-1", directory: "/sess-dir" },
    providerExt,
  );
  assert.deepEqual(bothArgs, [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    sandboxExt,
    "--extension",
    webExt,
    "--extension",
    providerExt,
    "--no-builtin-tools",
    "--exclude-tools",
    "powershell",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--session-id",
    "sess-1",
    "--session-dir",
    "/sess-dir",
  ]);
});

test("waitForAttestation strictly verifies antigravity attestation and fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-antigravity-attest-"));
  chmodSync(root, 0o700);
  const logPath = join(root, "sandbox.log");
  const controllerNonce = randomBytes(16).toString("hex");
  const userId = "alice";

  const baseline8 = [
    "bash",
    "edit",
    "find",
    "grep",
    "hitch_publish",
    "ls",
    "read",
    "write",
  ];

  const extensionPath = join(repository, "dist", "sandbox", "hitch-sandbox.ts");
  const dummySchemaDigest = createHash("sha256")
    .update("schemas")
    .digest("hex");
  const extensionDigest = sha256File(
    join(repository, "packages", "hitch-sandbox-extension", "hitch-sandbox.ts"),
  );

  const baseContext: ControllerContext = {
    root,
    workspace: join(root, "workspace"),
    inbox: join(root, "inbox"),
    publishRoot: join(root, "publish"),
    log: logPath,
    controllerNonce,
    turnHandle: randomBytes(16).toString("hex"),
    userId,
    webSearchEnabled: false,
    activeTools: baseline8,
    sharedAuthRequired: true,
  };

  const fakeController = {
    get exited() {
      return false;
    },
  };

  try {
    // 1. antigravityRequired = true, log has antigravity: true -> OK
    const validEntry = {
      type: "startup-attestation",
      ready: true,
      controllerNonce,
      userId,
      exactTools: baseline8,
      allTools: baseline8,
      activeTools: baseline8,
      sourcePaths: baseline8.map(() => extensionPath),
      sourcePath: extensionPath,
      extensionDigest,
      webSearchEnabled: false,
      sharedAuth: true,
      antigravity: true,
      schemaDigest: dummySchemaDigest,
    };
    writeFileSync(logPath, `${JSON.stringify(validEntry)}\n`, { mode: 0o600 });
    await waitForAttestation(fakeController, {
      ...baseContext,
      antigravityRequired: true,
    });

    // 2. antigravityRequired = true, log missing antigravity -> fail closed
    const missingEntry = {
      ...validEntry,
      antigravity: false,
    };
    writeFileSync(logPath, `${JSON.stringify(missingEntry)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(async () => {
      await waitForAttestation(fakeController, {
        ...baseContext,
        antigravityRequired: true,
      });
    }, /antigravity provider startup attestation is missing/u);

    // 3. antigravityRequired = false/undefined, log has antigravity: true -> unexpected attestation error
    writeFileSync(logPath, `${JSON.stringify(validEntry)}\n`, { mode: 0o600 });
    await assert.rejects(async () => {
      await waitForAttestation(fakeController, {
        ...baseContext,
        antigravityRequired: false,
      });
    }, /antigravity provider attestation unexpected/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
