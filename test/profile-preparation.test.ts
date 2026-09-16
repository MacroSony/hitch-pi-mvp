import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  preparePiProfile,
  preparePiProfiles,
  syncPiModelsStore,
  validatePiProfile,
} from "../src/pi/profile-preparation.js";
import {
  SHARED_AUTH_ENV,
  SHARED_AUTH_FAILED,
  installSharedAuthPreload,
} from "../src/pi/auth-preload.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

function setupSourceProfile(options?: {
  readonly auth?: Record<string, unknown>;
  readonly settings?: Record<string, unknown>;
  readonly models?: Record<string, unknown>;
  readonly modelsStore?: Record<string, unknown>;
}): { readonly root: string; readonly source: string } {
  const root = mkdtempSync(join(tmpdir(), "hitch-profile-test-"));
  chmodSync(root, 0o700);
  const source = join(root, "source-profile");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  chmodSync(source, 0o700);

  const authData = options?.auth ?? {
    providerA: {
      type: "oauth",
      access: "token-1",
      refresh: "refresh-1",
      expires: 1000,
    },
  };
  const authPath = join(source, "auth.json");
  writeFileSync(authPath, `${JSON.stringify(authData)}\n`, { mode: 0o600 });
  chmodSync(authPath, 0o600);

  if (options?.settings !== undefined) {
    const settingsPath = join(source, "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify(options.settings)}\n`, {
      mode: 0o600,
    });
    chmodSync(settingsPath, 0o600);
  }

  if (options?.models !== undefined) {
    const modelsPath = join(source, "models.json");
    writeFileSync(modelsPath, `${JSON.stringify(options.models)}\n`, {
      mode: 0o600,
    });
    chmodSync(modelsPath, 0o600);
  }

  if (options?.modelsStore !== undefined) {
    const storePath = join(source, "models-store.json");
    writeFileSync(storePath, `${JSON.stringify(options.modelsStore)}\n`, {
      mode: 0o600,
    });
    chmodSync(storePath, 0o600);
  }

  return { root, source };
}

test("preparePiProfiles stages settings.json and models.json for distinct users without copying auth.json", () => {
  const { root, source } = setupSourceProfile({
    settings: { defaultModel: "providerA/model-1" },
    models: { customProviders: [] },
    modelsStore: { cache: { entries: [1, 2] } },
  });
  const profileRoot = join(root, "pi-profiles");
  try {
    const result = preparePiProfiles(source, profileRoot, ["user-a", "user-b"]);

    const userADir = result.profiles.get("user-a");
    const userBDir = result.profiles.get("user-b");
    assert.notEqual(userADir, undefined);
    assert.notEqual(userBDir, undefined);
    assert.notEqual(userADir, userBDir);
    assert.equal(result.catalogProfile, userADir);

    // auth.json must NOT be copied to user profiles
    assert.equal(existsSync(join(userADir!, "auth.json")), false);
    assert.equal(existsSync(join(userBDir!, "auth.json")), false);

    // settings.json and models.json staged
    assert.deepEqual(
      JSON.parse(readFileSync(join(userADir!, "settings.json"), "utf8")),
      { defaultModel: "providerA/model-1" },
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(userBDir!, "settings.json"), "utf8")),
      { defaultModel: "providerA/model-1" },
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(userADir!, "models.json"), "utf8")),
      { customProviders: [] },
    );

    // models-store.json initial copy
    assert.deepEqual(
      JSON.parse(readFileSync(join(userADir!, "models-store.json"), "utf8")),
      { cache: { entries: [1, 2] } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native catalog cache synchronizes to every prepared user without copying profile authority", () => {
  const { root, source } = setupSourceProfile({
    settings: { userSpecific: true },
    models: { customProviders: [] },
    modelsStore: { stale: true },
  });
  const profileRoot = join(root, "pi-profiles");
  try {
    const prepared = preparePiProfiles(source, profileRoot, [
      "user-a",
      "user-b",
    ]);
    const catalog = prepared.catalogProfile;
    const userB = prepared.profiles.get("user-b");
    assert.notEqual(userB, undefined);

    writeFileSync(
      join(catalog, "models-store.json"),
      JSON.stringify({ refreshed: { model: "fixture/new-low" } }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(userB!, "models-store.json"),
      JSON.stringify({ old: true }),
      {
        mode: 0o600,
      },
    );

    syncPiModelsStore(catalog, prepared.profiles);

    assert.equal(
      readFileSync(join(userB!, "models-store.json"), "utf8"),
      readFileSync(join(catalog, "models-store.json"), "utf8"),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(userB!, "settings.json"), "utf8")),
      { userSpecific: true },
    );
    assert.equal(existsSync(join(userB!, "auth.json")), false);
    assert.equal(
      statSync(join(userB!, "models-store.json")).mode & 0o777,
      0o600,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparePiProfiles updates settings/models on restart, retains user models-store cache, and ignores old auth", () => {
  const { root, source } = setupSourceProfile({
    settings: { version: 1 },
    models: { version: 1 },
    modelsStore: { initial: true },
  });
  const profileRoot = join(root, "pi-profiles");
  try {
    // Initial run
    preparePiProfiles(source, profileRoot, ["user-a"]);
    const userADir = join(profileRoot, "user-a");

    // Simulate accumulated user cache in models-store.json
    writeFileSync(
      join(userADir, "models-store.json"),
      JSON.stringify({ userCachedData: "preserved" }),
      { mode: 0o600 },
    );

    // Simulate pre-existing / legacy auth.json in user profile
    const oldAuthContent = JSON.stringify({ legacy: "do-not-touch" });
    writeFileSync(join(userADir, "auth.json"), oldAuthContent, { mode: 0o600 });

    // Update source configurations
    writeFileSync(
      join(source, "settings.json"),
      JSON.stringify({ version: 2 }),
      { mode: 0o600 },
    );
    writeFileSync(join(source, "models.json"), JSON.stringify({ version: 2 }), {
      mode: 0o600,
    });
    writeFileSync(
      join(source, "models-store.json"),
      JSON.stringify({ shouldNotOverwriteUserStore: true }),
      { mode: 0o600 },
    );

    // Subsequent run (restart)
    preparePiProfiles(source, profileRoot, ["user-a"]);

    // settings.json and models.json updated to version 2
    assert.deepEqual(
      JSON.parse(readFileSync(join(userADir, "settings.json"), "utf8")),
      { version: 2 },
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(userADir, "models.json"), "utf8")),
      { version: 2 },
    );

    // models-store.json preserved user cache, not overwritten by source
    assert.deepEqual(
      JSON.parse(readFileSync(join(userADir, "models-store.json"), "utf8")),
      { userCachedData: "preserved" },
    );

    // old user auth.json retained untouched
    assert.equal(
      readFileSync(join(userADir, "auth.json"), "utf8"),
      oldAuthContent,
    );

    // source auth.json unmodified
    assert.equal(existsSync(join(source, "auth.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparePiProfiles removes stale managed files when deleted from source", () => {
  const { root, source } = setupSourceProfile({
    settings: { active: true },
    models: { active: true },
  });
  const profileRoot = join(root, "pi-profiles");
  try {
    preparePiProfiles(source, profileRoot, ["user-a"]);
    const userADir = join(profileRoot, "user-a");
    assert.equal(existsSync(join(userADir, "settings.json")), true);
    assert.equal(existsSync(join(userADir, "models.json")), true);

    // Remove managed files from source
    rmSync(join(source, "settings.json"));
    rmSync(join(source, "models.json"));

    // Prepare again
    preparePiProfiles(source, profileRoot, ["user-a"]);

    // Managed files removed from user profile to prevent stale configuration
    assert.equal(existsSync(join(userADir, "settings.json")), false);
    assert.equal(existsSync(join(userADir, "models.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparePiProfile directly prepares a target profile directory", () => {
  const { root, source } = setupSourceProfile({
    settings: { direct: true },
  });
  const target = join(root, "target-profile");
  try {
    validatePiProfile(source);
    preparePiProfile(source, target);
    assert.equal(existsSync(join(target, "settings.json")), true);
    assert.equal(existsSync(join(target, "auth.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparePiProfiles handles empty userIds with default catalog profile", () => {
  const { root, source } = setupSourceProfile({
    settings: { default: true },
  });
  const profileRoot = join(root, "pi-profiles");
  try {
    const result = preparePiProfiles(source, profileRoot, []);
    assert.equal(result.catalogProfile, join(profileRoot, "default"));
    assert.equal(result.profiles.size, 0);
    assert.equal(
      existsSync(join(profileRoot, "default", "settings.json")),
      true,
    );
    assert.equal(existsSync(join(profileRoot, "default", "auth.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparePiProfiles rejects duplicate user IDs, unsafe identifiers, and symbolic links", () => {
  const { root, source } = setupSourceProfile();
  const profileRoot = join(root, "pi-profiles");
  try {
    assert.throws(
      () => preparePiProfiles(source, profileRoot, ["user-1", "user-1"]),
      /duplicate Pi profile user id/u,
    );
    assert.throws(
      () => preparePiProfiles(source, profileRoot, ["../escape"]),
      /Pi profile user id is invalid/u,
    );

    // Symbolic link in target throws
    const targetWithLink = join(profileRoot, "linked-user");
    mkdirSync(targetWithLink, { recursive: true, mode: 0o700 });
    const realTarget = join(root, "real-file.json");
    writeFileSync(realTarget, "{}\n", { mode: 0o600 });
    symlinkSync(realTarget, join(targetWithLink, "link.json"));
    assert.throws(
      () => preparePiProfiles(source, profileRoot, ["linked-user"]),
      /symbolic link/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth-preload rejects missing env, conflicting credentials, and conflicting authPath", async () => {
  installSharedAuthPreload();

  const previousEnv = process.env[SHARED_AUTH_ENV];
  delete process.env[SHARED_AUTH_ENV];

  try {
    // Missing env fails closed with shared-auth-failed
    await assert.rejects(
      () => ModelRuntime.create(),
      (error: unknown) => {
        assert.equal(
          error instanceof Error && error.message,
          SHARED_AUTH_FAILED,
        );
        return true;
      },
    );

    // Conflicting credentials fails closed
    await assert.rejects(
      () =>
        ModelRuntime.create({
          credentials: {
            read: async () => undefined,
            list: async () => [],
            modify: async () => undefined,
            delete: async () => undefined,
          },
        }),
      (error: unknown) => {
        assert.equal(
          error instanceof Error && error.message,
          SHARED_AUTH_FAILED,
        );
        return true;
      },
    );

    // Conflicting authPath fails closed
    await assert.rejects(
      () => ModelRuntime.create({ authPath: "/some/path" }),
      (error: unknown) => {
        assert.equal(
          error instanceof Error && error.message,
          SHARED_AUTH_FAILED,
        );
        return true;
      },
    );

    // Unsafe / nonexistent path fails closed
    process.env[SHARED_AUTH_ENV] = "/nonexistent/path/auth.json";
    await assert.rejects(
      () => ModelRuntime.create(),
      (error: unknown) => {
        assert.equal(
          error instanceof Error && error.message,
          SHARED_AUTH_FAILED,
        );
        return true;
      },
    );
  } finally {
    if (previousEnv === undefined) delete process.env[SHARED_AUTH_ENV];
    else process.env[SHARED_AUTH_ENV] = previousEnv;
  }
});
