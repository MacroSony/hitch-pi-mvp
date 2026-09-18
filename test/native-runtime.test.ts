import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import {
  NativePiRuntime,
  preflightNativeModel,
  parseCatalog,
  refreshPiCatalog,
  validatePiProfile,
  validatePiPackage,
  toolArgPreview,
} from "../src/pi/native-runtime.js";
import { SharedCredentialStore } from "../src/pi/shared-credentials.js";
import type { RuntimeModel, RuntimeTurn } from "../src/runtime/runtime.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

const PREFLIGHT_MODELS: readonly RuntimeModel[] = [
  {
    provider: "fixture",
    id: "plain",
    name: "Plain",
    reasoning: false,
    input: ["text"],
    thinkingLevels: ["off"],
  },
  {
    provider: "fixture",
    id: "new-low",
    name: "New low",
    reasoning: true,
    input: ["text"],
    thinkingLevels: ["low", "medium"],
  },
];

function preflightTurn(changes: Partial<RuntimeTurn> = {}): RuntimeTurn {
  return {
    turnId: "turn-1",
    userId: "alice",
    sessionId: "session-1",
    prompt: "offline preflight",
    ...changes,
  };
}

test("model preflight returns stable reusable failures without a controller", () => {
  const incomplete = preflightNativeModel(
    PREFLIGHT_MODELS,
    preflightTurn({ modelProvider: "fixture" }),
    "alice",
    undefined,
    [],
  );
  assert.deepEqual(incomplete, {
    outcome: "failed",
    text: "",
    error: "model-unavailable",
    sessionReusable: true,
  });

  const unsupportedThinking = preflightNativeModel(
    PREFLIGHT_MODELS,
    preflightTurn({
      modelProvider: "fixture",
      modelId: "plain",
      thinkingLevel: "low",
    }),
    "alice",
    undefined,
    [],
  );
  assert.equal("outcome" in unsupportedThinking, true);
  if (!("outcome" in unsupportedThinking)) return;
  assert.equal(unsupportedThinking.outcome, "failed");
  assert.equal(unsupportedThinking.error, "model-unavailable");
  assert.equal(unsupportedThinking.sessionReusable, true);
});

test("missing model and invalid thinking are reusable pre-controller failures", () => {
  for (const changes of [
    { modelProvider: "fixture", modelId: "removed" },
    { modelId: "plain" },
    {
      modelProvider: "fixture",
      modelId: "new-low",
      thinkingLevel: "max" as const,
    },
  ]) {
    assert.deepEqual(
      preflightNativeModel(
        PREFLIGHT_MODELS,
        preflightTurn(changes),
        "alice",
        undefined,
        [],
      ),
      {
        outcome: "failed",
        text: "",
        error: "model-unavailable",
        sessionReusable: true,
      },
    );
  }
});

test("model preflight uses a Forge model before falling back to the first model", () => {
  const result = preflightNativeModel(
    PREFLIGHT_MODELS,
    preflightTurn({ forgeSelection: { kind: "profile", id: "low" } }),
    "alice",
    {
      isEnabled: () => true,
      list: () => [],
      resolve: () => ({
        selection: { kind: "profile", id: "low" },
        name: "low",
        mode: "replace",
        systemPrompt: "use low",
        model: { provider: "fixture", id: "new-low" },
        thinkingLevel: "low",
      }),
    },
    [],
  );
  assert.equal("outcome" in result, false);
  if ("outcome" in result) return;
  assert.equal(result.model.id, "new-low");
  assert.equal(result.thinkingLevel, "low");
});

test("native catalog refresh uses only metadata, retains cache on failure/timeout, and publishes deepseek-flash + low", async () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-catalog-test-"));
  chmodSync(root, 0o700);
  const profile = join(root, "catalog-profile");
  privateDirectory(profile);
  const authPath = join(profile, "auth.json");
  const modelsPath = join(profile, "models.json");
  const modelsStorePath = join(profile, "models-store.json");
  const auth = JSON.stringify({
    deepseek: { type: "api_key", key: "fixture-secret" },
  });
  writeFileSync(authPath, auth, { mode: 0o600 });
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }), { mode: 0o600 });
  let mode: "ok" | "error" | "timeout" | "invalid" = "ok";
  const requests: Array<{
    path: string;
    method: string;
    authenticated: boolean;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      method: request.method ?? "",
      authenticated: request.headers.authorization !== undefined,
    });
    if (mode === "timeout") return;
    if (mode === "error") {
      response.statusCode = 503;
      response.end("fixture-secret: unavailable");
      return;
    }
    if (mode === "invalid") {
      response.end("not valid JSON: fixture-secret");
      return;
    }
    response.setHeader("last-modified", "Thu, 01 Jan 2099 00:00:00 GMT");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: "deepseek-flash",
          name: "Fixture Flash",
          reasoning: true,
          input: ["text", "image"],
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
          },
        },
      ]),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const options = {
    timeoutMs: 4_000,
    catalogBaseUrl: `http://127.0.0.1:${address.port}`,
  };
  const cached = () =>
    JSON.parse(readFileSync(modelsStorePath, "utf8")) as Record<
      string,
      {
        models: Array<{ id: string }>;
        checkedAt?: number;
      }
    >;
  const makeStale = () => {
    const data = cached();
    data.deepseek!.checkedAt = 0;
    writeFileSync(modelsStorePath, JSON.stringify(data), { mode: 0o600 });
  };
  try {
    assert.equal(await refreshPiCatalog(profile, authPath, options), false);
    const offline = await ModelRuntime.create({
      credentials: new SharedCredentialStore(authPath),
      modelsPath,
      modelsStorePath,
      allowModelNetwork: false,
    });
    const models = parseCatalog({ models: offline.getAvailableSnapshot() });
    const flash = models.find(
      (model) => model.provider === "deepseek" && model.id === "deepseek-flash",
    );
    assert.deepEqual(flash?.thinkingLevels, ["low", "high", "max"]);
    assert.deepEqual(flash?.input, ["image", "text"]);
    assert.equal(
      "outcome" in
        preflightNativeModel(
          models,
          preflightTurn({
            modelProvider: "deepseek",
            modelId: "deepseek-flash",
            thinkingLevel: "low",
          }),
          "alice",
          undefined,
          [],
        ),
      false,
    );
    assert.equal(cached().deepseek?.models[0]?.id, "deepseek-flash");

    for (const failure of ["error", "invalid", "timeout"] as const) {
      mode = failure;
      makeStale();
      const start = Date.now();
      assert.equal(
        await refreshPiCatalog(profile, authPath, {
          ...options,
          timeoutMs: failure === "timeout" ? 250 : 4_000,
        }),
        true,
      );
      assert.ok(Date.now() - start < 4_000, "refresh must remain bounded");
      assert.equal(cached().deepseek?.models[0]?.id, "deepseek-flash");
    }
    assert.ok(requests.length >= 4);
    assert.ok(
      requests.every(
        (request) =>
          request.method === "GET" &&
          request.path.startsWith("/api/models/providers/") &&
          !request.authenticated,
      ),
    );
    assert.equal(
      readFileSync(modelsStorePath, "utf8").includes("fixture-secret"),
      false,
    );
    assert.equal(readFileSync(authPath, "utf8"), auth);

    // Bad local config/cache/credentials are not a network fallback.
    const count = requests.length;
    writeFileSync(modelsPath, '{"providers": []}', { mode: 0o600 });
    await assert.rejects(
      () => refreshPiCatalog(profile, authPath, options),
      /local state is invalid/u,
    );
    writeFileSync(modelsPath, '{"providers": {}}', { mode: 0o600 });
    writeFileSync(modelsStorePath, "{broken", { mode: 0o600 });
    await assert.rejects(
      () => refreshPiCatalog(profile, authPath, options),
      /JSON is corrupt/u,
    );
    writeFileSync(modelsStorePath, "{}", { mode: 0o600 });
    chmodSync(authPath, 0o644);
    await assert.rejects(
      () => refreshPiCatalog(profile, authPath, options),
      /unsafe JSON file/u,
    );
    assert.equal(requests.length, count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired OAuth availability is offline; a network refresh failure preserves the authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-catalog-oauth-"));
  chmodSync(root, 0o700);
  const authPath = join(root, "auth.json");
  const auth = JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "fixture-expired",
      refresh: "fixture-private",
      expires: 0,
    },
  });
  writeFileSync(authPath, auth, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new TypeError("fetch failed: fixture-private");
  };
  try {
    const offline = await ModelRuntime.create({
      credentials: new SharedCredentialStore(authPath),
      modelsPath: join(root, "models.json"),
      modelsStorePath: join(root, "models-store.json"),
      allowModelNetwork: false,
    });
    assert.equal(offline.getError(), undefined);
    assert.ok(
      offline
        .getAvailableSnapshot()
        .some((model) => model.provider === "openai-codex"),
    );
    assert.equal(
      requests,
      0,
      "native OAuth availability must not refresh auth",
    );
    assert.equal(
      await refreshPiCatalog(root, authPath, { timeoutMs: 2_000 }),
      true,
    );
    assert.ok(requests > 0);
    assert.equal(readFileSync(authPath, "utf8"), auth);
    assert.equal(
      readFileSync(join(root, "models-store.json"), "utf8").includes(
        "fixture-private",
      ),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal npm ci produces the exact pinned Pi package and installed dependency closure", () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  validatePiPackage(
    join(
      repository,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    ),
  );
});

test("Pi profile validation is content-free and gives the attended recovery path", () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-profile-test-"));
  chmodSync(root, 0o700);
  const profile = join(root, "profile");
  privateDirectory(profile);
  const auth = join(profile, "auth.json");
  writeFileSync(auth, "{}\n", { mode: 0o600 });
  validatePiProfile(profile);

  chmodSync(auth, 0o644);
  assert.throws(() => validatePiProfile(profile), /unsafe JSON file/u);
  chmodSync(auth, 0o600);
  writeFileSync(auth, "{broken\n", { mode: 0o600 });
  assert.throws(
    () => validatePiProfile(profile),
    /restore the operator backup or log in again/u,
  );
});

test("production sandbox sources are staged from the pinned package mirror", () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const source = join(repository, "packages", "hitch-sandbox-extension");
  const staged = join(repository, "dist", "sandbox");
  for (const name of [
    "hitch-sandbox.ts",
    "sandbox-backend.mjs",
    "sandbox-worker.mjs",
  ]) {
    assert.deepEqual(
      readFileSync(join(source, name)),
      readFileSync(join(staged, name)),
      name,
    );
  }

  // Phase 0 reviewed spike assets remain frozen historical evidence. The
  // PAR-2 unit namespacing intentionally diverges the production package from
  // those spikes while keeping the safety contract.

  for (const name of [
    "hitch-sandbox.ts",
    "sandbox-backend.mjs",
    "sandbox-worker.mjs",
  ]) {
    assert.equal(statSync(join(staged, name)).mode & 0o777, 0o444);
  }
  assert.equal(
    statSync(join(staged, "secure-bwrap-helper")).mode & 0o777,
    0o555,
  );
});

test(
  "opt-in native startup attests Pi and the Bubblewrap extension",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hitch-native-test-"));
    chmodSync(root, 0o700);
    const dataRoot = join(root, "data");
    const profile = join(root, "profile");
    privateDirectory(dataRoot);
    privateDirectory(profile);
    writeFileSync(join(profile, "auth.json"), "{}\n", { mode: 0o600 });
    await assert.rejects(
      () =>
        NativePiRuntime.create({
          dataRoot,
          piProfileDir: profile,
          turnTimeoutMs: 2_000,
        }),
      /no authenticated available model/u,
    );
  },
);

test(
  "opt-in publication snapshot uses the production descriptor-confined helper",
  { skip: process.env.HITCH_RUN_SANDBOX_TESTS !== "1" },
  async () => {
    const repository = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const assets = join(repository, "dist", "sandbox");
    const root = mkdtempSync(join(tmpdir(), "hitch-publish-test-"));
    chmodSync(root, 0o700);
    const workspace = join(root, "workspace");
    const inbox = join(root, "inbox");
    const publishRoot = join(root, "publish");
    for (const path of [workspace, inbox, publishRoot]) privateDirectory(path);
    writeFileSync(join(workspace, "result.txt"), "publication-check", {
      mode: 0o600,
    });
    const worker = join(assets, "sandbox-worker.mjs");
    const helper = join(assets, "secure-bwrap-helper");
    const sha256 = (path: string): string =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    const artifactId = randomBytes(16).toString("hex");
    try {
      const backend = (await import(
        pathToFileURL(join(assets, "sandbox-backend.mjs")).href
      )) as {
        executeSandboxRequest(
          input: Record<string, unknown>,
          request: Record<string, unknown>,
        ): Promise<unknown>;
        activeSandboxUnitCount(): number;
      };
      const result = (await backend.executeSandboxRequest(
        {
          workspace,
          inbox,
          publishRoot,
          worker,
          helper,
          log: join(root, "sandbox.log"),
          turnHandle: randomBytes(16).toString("hex"),
          unitPrefix: randomBytes(8).toString("hex"),
          workerSha256: sha256(worker),
          helperSha256: sha256(helper),
          temporaryBytes: 4 * 1024 * 1024,
          memoryBytes: 256 * 1024 * 1024,
          maximumProcesses: 32,
          wallMilliseconds: 8_000,
        },
        {
          operation: "hitch_publish",
          input: { path: "result.txt", artifactId },
        },
      )) as { bytes: number; sha256: string };
      const artifact = join(publishRoot, `${artifactId}.blob`);
      assert.equal(result.bytes, 17);
      assert.equal(result.sha256, sha256(artifact));
      assert.equal(readFileSync(artifact, "utf8"), "publication-check");
      assert.equal(backend.activeSandboxUnitCount(), 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("toolArgPreview prefers primary keys, flattens whitespace, and clips", () => {
  assert.equal(toolArgPreview(undefined), "");
  assert.equal(toolArgPreview(null), "");
  assert.equal(toolArgPreview([]), "");
  assert.equal(toolArgPreview({}), "");
  assert.equal(toolArgPreview({ count: 3 }), "");
  assert.equal(toolArgPreview({ command: "ls  -la\n/tmp" }), " · ls -la /tmp");
  assert.equal(
    toolArgPreview({ path: "/tmp/x", command: "echo hi" }),
    " · echo hi",
  );
  const long = toolArgPreview({ query: "q".repeat(120) });
  assert.ok(long.startsWith(" · "));
  assert.ok(long.endsWith("…"));
  assert.equal(Array.from(long).length, 3 + 60 + 1);
});
