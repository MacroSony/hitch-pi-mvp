import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  readdirSync,
  statSync,
  utimesSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SharedCredentialStore,
  validateSharedAuthPath,
} from "../src/pi/shared-credentials.js";

const execFile = promisify(execFileCallback);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const child = join(
  repository,
  "test",
  "fixtures",
  "shared-credentials-child.mjs",
);

function setup(initial: Record<string, unknown>): {
  readonly root: string;
  readonly auth: string;
} {
  const root = mkdtempSync(join(tmpdir(), "hitch-shared-auth-"));
  chmodSync(root, 0o700);
  const auth = join(root, "auth.json");
  writeFileSync(auth, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
  chmodSync(auth, 0o600);
  return { root, auth };
}

function assertSafeFailure(error: unknown, root: string, secret: string): void {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  assert.doesNotMatch(
    text,
    new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );
  assert.equal(text.includes(secret), false);
  assert.match(text, /shared credential/u);
}

async function runChild(
  auth: string,
  provider: string,
  mode?: string,
): Promise<string> {
  const result = await execFile(
    process.execPath,
    [child, auth, provider, mode ?? "refresh"],
    {
      cwd: repository,
      timeout: 5_000,
      maxBuffer: 32 * 1024,
    },
  );
  return result.stdout.trim();
}

test("shared auth validates private canonical files and does not create missing auth", () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-shared-path-"));
  chmodSync(root, 0o700);
  const missing = join(root, "missing.json");
  assert.throws(
    () => new SharedCredentialStore(missing),
    /shared credential storage failure/u,
  );
  assert.equal(existsSync(missing), false);

  const auth = join(root, "auth.json");
  writeFileSync(auth, "{}\n", { mode: 0o600 });
  chmodSync(auth, 0o600);
  assert.equal(validateSharedAuthPath(auth), auth);
  chmodSync(auth, 0o644);
  assert.throws(
    () => new SharedCredentialStore(auth),
    /shared credential storage failure/u,
  );
  rmSync(root, { recursive: true, force: true });
});

test("read resolves Pi API-key templates but list never resolves or executes them", async () => {
  const commandMarker = join(
    tmpdir(),
    `hitch-shared-command-${process.pid}-was-executed`,
  );
  rmSync(commandMarker, { force: true });
  const { root, auth } = setup({
    literal: {
      type: "api_key",
      key: "pre-$LOCAL_TOKEN-${GLOBAL_TOKEN}-$$LOCAL_TOKEN-$!suffix",
      env: { LOCAL_TOKEN: "provider-value" },
    },
    command: { type: "api_key", key: `!touch ${commandMarker}` },
    missingEnv: {
      type: "api_key",
      key: "$HITCH_SHARED_CREDENTIALS_MISSING_7A1D",
    },
  });
  const previousLocal = process.env.LOCAL_TOKEN;
  const previousGlobal = process.env.GLOBAL_TOKEN;
  process.env.LOCAL_TOKEN = "process-value";
  process.env.GLOBAL_TOKEN = "global-value";
  try {
    const store = new SharedCredentialStore(auth);
    assert.deepEqual(await store.read("literal"), {
      type: "api_key",
      key: "pre-provider-value-global-value-$LOCAL_TOKEN-!suffix",
      env: { LOCAL_TOKEN: "provider-value" },
    });
    assert.deepEqual(await store.list(), [
      { providerId: "literal", type: "api_key" },
      { providerId: "command", type: "api_key" },
      { providerId: "missingEnv", type: "api_key" },
    ]);
    assert.equal(existsSync(commandMarker), false);
    await assert.rejects(
      () => store.read("command"),
      (error: unknown) => {
        assertSafeFailure(error, root, commandMarker);
        return true;
      },
    );
    await assert.rejects(
      () => store.read("missingEnv"),
      (error: unknown) => {
        assertSafeFailure(error, root, "HITCH_SHARED_CREDENTIALS_MISSING_7A1D");
        return true;
      },
    );
  } finally {
    if (previousLocal === undefined) delete process.env.LOCAL_TOKEN;
    else process.env.LOCAL_TOKEN = previousLocal;
    if (previousGlobal === undefined) delete process.env.GLOBAL_TOKEN;
    else process.env.GLOBAL_TOKEN = previousGlobal;
    rmSync(root, { recursive: true, force: true });
  }
});

test("modify is durable across a restart, preserves OAuth extensions, and undefined is nochange", async () => {
  const { root, auth } = setup({
    alpha: {
      type: "oauth",
      access: "old-access",
      refresh: "refresh-token",
      expires: 1,
      account: "operator",
    },
    beta: { type: "api_key", key: "beta-key", region: "one" },
  });
  try {
    const store = new SharedCredentialStore(auth);
    const before = await store.read("alpha");
    assert.notEqual(before, undefined);
    const beforeExpected = structuredClone(before);
    if (before?.type === "oauth") before.access = "mutated-snapshot";
    const isolated = await store.read("alpha");
    assert.equal(isolated?.type, "oauth");
    if (isolated?.type === "oauth") assert.equal(isolated.access, "old-access");
    const unchanged = await store.modify("alpha", async (current) => {
      assert.equal(current?.type, "oauth");
      return undefined;
    });
    assert.deepEqual(unchanged, beforeExpected);
    await store.modify("alpha", async (current) => {
      assert.equal(current?.type, "oauth");
      return { ...current, access: "new-access", expires: 9 };
    });
    const restarted = new SharedCredentialStore(auth);
    assert.deepEqual(await restarted.read("alpha"), {
      type: "oauth",
      access: "new-access",
      refresh: "refresh-token",
      expires: 9,
      account: "operator",
    });
    await assert.rejects(
      store.modify("alpha", async () => {
        throw new Error("callback-dummy-token");
      }),
      (error: unknown) => {
        assertSafeFailure(error, root, "callback-dummy-token");
        return true;
      },
    );
    await restarted.delete("beta");
    assert.equal(await new SharedCredentialStore(auth).read("beta"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one lock protects concurrent providers and refreshes a rotated OAuth value once", async () => {
  const { root, auth } = setup({
    providerA: {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 0,
    },
    providerB: { type: "api_key", key: "b-key" },
  });
  try {
    const store = new SharedCredentialStore(auth);
    await Promise.all([
      store.modify("providerA", async (current) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
        return current === undefined
          ? undefined
          : { ...current, access: "local-access" };
      }),
      store.modify("providerB", async (current) => current),
    ]);
    const local = new SharedCredentialStore(auth);
    assert.equal((await local.read("providerA"))?.type, "oauth");
    assert.equal((await local.read("providerB"))?.type, "api_key");

    const outputs = await Promise.all([
      runChild(auth, "providerA"),
      runChild(auth, "providerA"),
    ]);
    assert.equal(
      outputs.filter((output) => JSON.parse(output).refreshed === true).length,
      1,
    );
    assert.equal(
      (await new SharedCredentialStore(auth).read("providerA"))?.type,
      "oauth",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock wait observes abort without leaking path or credential data", async () => {
  const { root, auth } = setup({
    provider: {
      type: "oauth",
      access: "dummy-access",
      refresh: "dummy-refresh",
      expires: 0,
    },
  });
  try {
    const holder = runChild(auth, "provider", "hold:350");
    const lockPath = `${auth}.lock`;
    for (let attempt = 0; attempt < 50 && !existsSync(lockPath); attempt += 1)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    assert.equal(existsSync(lockPath), true);
    const controller = new AbortController();
    const pending = new SharedCredentialStore(auth).modify(
      "provider",
      async (current) => current,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (error: unknown) => {
      assert.equal(error instanceof Error && error.name, "AbortError");
      assertSafeFailure(error, root, "dummy-access");
      return true;
    });
    await holder;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed, oversized, symlinked, and hard-linked auth files fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-shared-unsafe-"));
  chmodSync(root, 0o700);
  const auth = join(root, "auth.json");
  const secret = "dummy-token";
  try {
    writeFileSync(auth, "{broken\n", { mode: 0o600 });
    assert.throws(
      () => new SharedCredentialStore(auth),
      (error: unknown) => {
        assertSafeFailure(error, root, secret);
        return true;
      },
    );
    writeFileSync(auth, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    assert.throws(
      () => new SharedCredentialStore(auth),
      /shared credential storage failure/u,
    );

    writeFileSync(auth, "{}\n", { mode: 0o600 });
    const target = join(root, "real-auth.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    rmSync(auth);
    symlinkSync(target, auth);
    assert.throws(
      () => new SharedCredentialStore(auth),
      /shared credential storage failure/u,
    );

    rmSync(auth);
    writeFileSync(auth, "{}\n", { mode: 0o600 });
    linkSync(auth, join(root, "auth-copy.json"));
    assert.throws(
      () => new SharedCredentialStore(auth),
      /shared credential storage failure/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized persistence fails before rename and leaves the old auth complete", async () => {
  const { root, auth } = setup({
    provider: {
      type: "oauth",
      access: "keep-access",
      refresh: "keep-refresh",
      expires: 1,
    },
  });
  try {
    const original = readFileSync(auth, "utf8");
    await assert.rejects(
      new SharedCredentialStore(auth).modify("provider", async (current) => {
        if (current === undefined)
          throw new Error("missing fixture credential");
        return {
          ...current,
          extra: "x".repeat(1024 * 1024),
        };
      }),
      /shared credential storage failure/u,
    );
    assert.equal(readFileSync(auth, "utf8"), original);
    assert.deepEqual(await new SharedCredentialStore(auth).read("provider"), {
      type: "oauth",
      access: "keep-access",
      refresh: "keep-refresh",
      expires: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "SIGKILL before atomic rename leaves a complete authority and stale lock is recoverable",
  { timeout: 10000 },
  async () => {
    const { root, auth } = setup({
      sample: {
        type: "oauth",
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
      },
    });
    const process_ = spawn(
      process.execPath,
      [child, auth, "sample", "crash-before-rename"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    process_.stdout.setEncoding("utf8");
    process_.stderr.setEncoding("utf8");
    process_.stdout.on("data", (text) => {
      output += text;
    });
    process_.stderr.on("data", (text) => {
      errors += text;
    });
    const closed = once(process_, "close");
    try {
      await new Promise<void>((ok, fail) => {
        const timer = setTimeout(
          () => fail(new Error("fixture did not reach commit boundary")),
          5000,
        );
        process_.stdout.on("data", () => {
          if (output.includes("commit-ready")) {
            clearTimeout(timer);
            ok();
          }
        });
        process_.once("exit", () => {
          clearTimeout(timer);
          fail(new Error("fixture exited before boundary"));
        });
      });
      process_.kill("SIGKILL");
      await closed;
      assert.equal(
        JSON.parse(readFileSync(auth, "utf8")).sample.access,
        "old-access",
      );
      const temporary = readdirSync(root).find((name) =>
        name.startsWith("auth.json.tmp-"),
      );
      assert.ok(temporary);
      assert.equal(statSync(join(root, temporary)).mode & 0o777, 0o600);
      assert.equal(
        JSON.parse(readFileSync(join(root, temporary), "utf8")).sample.access,
        "rotated-access",
      );
      // Only a dead fixture's lock is aged; production never force-unlocks a live writer.
      const old = new Date(Date.now() - 60000);
      utimesSync(auth + ".lock", old, old);
      const reopened = new SharedCredentialStore(auth);
      await reopened.modify("other", async () => ({
        type: "api_key",
        key: "test-only",
      }));
      assert.equal((await reopened.read("sample"))?.type, "oauth");
      assert.equal(
        JSON.parse(readFileSync(auth, "utf8")).sample.access,
        "old-access",
      );
      assert.equal(existsSync(auth + ".lock"), false);
      assert.equal(errors, "");
      assert.doesNotMatch(
        output,
        /old-access|old-refresh|rotated-access|rotated-refresh/u,
      );
    } finally {
      if (process_.exitCode === null && process_.signalCode === null) {
        process_.kill("SIGKILL");
        await closed;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
