import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseConfig } from "../src/config/config.js";
import { bootstrapFoundation } from "../src/foundation/bootstrap.js";

interface SandboxBackend {
  executeSandboxRequest(
    input: Record<string, unknown>,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  activeSandboxUnitCount(): number;
}

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly dadWorkspace: string;
  readonly inbox: string;
  readonly publishRoot: string;
  readonly hostSecret: string;
  readonly hostSocket: string;
  readonly hostSocketServer: Server;
  readonly backendInput: Record<string, unknown>;
  readonly backend: SandboxBackend;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function backendAssets(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../sandbox");
}

async function loadBackend(): Promise<SandboxBackend> {
  return (await import(
    pathToFileURL(join(backendAssets(), "sandbox-backend.mjs")).href
  )) as SandboxBackend;
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hitch-dad-sandbox-"));
  chmodSync(root, 0o700);
  const workspace = join(root, "parent-workspace");
  const dadWorkspace = join(root, "dad-workspace");
  const inbox = join(root, "inbox");
  const publishRoot = join(root, "publish");
  for (const path of [workspace, dadWorkspace, inbox, publishRoot])
    privateDirectory(path);

  const hostSecret = join(root, "parent-host-auth-sentinel");
  const otherUserSecret = join(dadWorkspace, "dad-private-sentinel");
  writeFileSync(hostSecret, "SYNTHETIC_PARENT_HOST_AUTH\n", {
    mode: 0o600,
  });
  writeFileSync(otherUserSecret, "SYNTHETIC_DAD_PRIVATE\n", { mode: 0o600 });
  writeFileSync(join(workspace, "inside.txt"), "parent workspace\n", {
    mode: 0o600,
  });
  writeFileSync(join(inbox, "incoming.txt"), "read-only inbound\n", {
    mode: 0o600,
  });
  // Same-UID hard links are deliberately recorded as a limitation rather than
  // treated as a cross-UID defense. The synthetic source is not a credential.
  linkSync(hostSecret, join(workspace, "same-uid-hardlink.txt"));
  // Directory symlinks are included because directory list/search code must not
  // turn a workspace path into an arbitrary host path. The target is outside
  // the bwrap mounts and must remain unreachable from the worker.
  const hostDirectory = join(root, "host-directory");
  privateDirectory(hostDirectory);
  writeFileSync(
    join(hostDirectory, "outside.txt"),
    "HOST_DIRECTORY_SENTINEL\n",
    {
      mode: 0o600,
    },
  );
  const directoryLink = join(workspace, "directory-link");
  symlinkSync(hostSecret, join(workspace, "file-link"));
  const hostSocket = join(root, "host.sock");
  const socketServer = createServer();
  socketServer.listen(hostSocket);
  await once(socketServer, "listening");
  // The socket remains live until fixture cleanup. The worker must not be able
  // to reach it through an unmounted host path.
  socketServer.unref();
  // A link that would leave the workspace on the host is also tested. The
  // worker must not resolve this path through its host filesystem.
  symlinkSync(hostDirectory, directoryLink);

  const assets = backendAssets();
  const worker = join(assets, "sandbox-worker.mjs");
  const helper = join(assets, "secure-bwrap-helper");
  const backend = await loadBackend();
  return {
    root,
    workspace,
    dadWorkspace,
    inbox,
    publishRoot,
    hostSecret,
    hostSocket,
    hostSocketServer: socketServer,
    backend,
    backendInput: {
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
  };
}

function cleanupFixture(fixture: Fixture): void {
  // The socket path is in our private temporary root, so this cannot touch a
  // service socket. rmSync also removes the workspace hard link, not its source.
  fixture.hostSocketServer.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

async function request(
  fixture: Fixture,
  operation: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return (await fixture.backend.executeSandboxRequest(
    fixture.backendInput,
    { operation, input },
    signal,
  )) as Record<string, unknown>;
}

async function assertSandboxFailure(
  fixture: Fixture,
  operation: string,
  input: Record<string, unknown>,
): Promise<void> {
  await assert.rejects(
    () => request(fixture, operation, input),
    /sandbox-failed/u,
  );
}

test("synthetic parent and dad roots publish as distinct owner-scoped database rows", () => {
  const root = mkdtempSync(join(tmpdir(), "hitch-dad-db-"));
  chmodSync(root, 0o700);
  const dataRoot = join(root, "data");
  const profile = join(root, "pi-profile");
  const state = join(root, "wechat-state");
  const parentWorkspace = join(root, "parent-workspace");
  const dadWorkspace = join(root, "dad-workspace");
  for (const path of [dataRoot, profile, state, parentWorkspace, dadWorkspace])
    privateDirectory(path);
  try {
    const config = parseConfig({
      schemaVersion: 1,
      dataRoot,
      piProfileDir: profile,
      minimumFreeBytes: 0,
      telegramAccounts: [
        { id: "synthetic", botTokenEnv: "HITCH_SYNTHETIC_TOKEN" },
      ],
      wechatAccounts: [{ id: "synthetic", stateDir: state }],
      users: [
        {
          id: "parent",
          workspace: parentWorkspace,
          telegram: {
            account: "synthetic",
            userId: "parent-platform",
            privateChatId: "parent-chat",
          },
        },
        {
          id: "dad",
          workspace: dadWorkspace,
          telegram: {
            account: "synthetic",
            userId: "dad-platform",
            privateChatId: "dad-chat",
          },
        },
      ],
    });
    const foundation = bootstrapFoundation(config);
    try {
      const database = foundation.database.connection;
      const users = (
        database
          .prepare("SELECT id, workspace_path FROM users ORDER BY id")
          .all() as Array<{ id: string; workspace_path: string }>
      ).map(({ id, workspace_path }) => ({ id, workspace_path }));
      assert.deepEqual(users, [
        { id: "dad", workspace_path: dadWorkspace },
        { id: "parent", workspace_path: parentWorkspace },
      ]);
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM users").get()?.count,
        2n,
      );

      database
        .prepare(
          `INSERT INTO sessions(id, user_id, name, pi_session_id, state, created_at, updated_at)
           VALUES ('parent-session', 'parent', 'main', 'parent-pi', 'active', 1, 1)`,
        )
        .run();
      const dadEndpoint = database
        .prepare(
          "SELECT id FROM channel_endpoints WHERE user_id = 'dad' LIMIT 1",
        )
        .get() as { id: string };
      assert.throws(
        () =>
          database
            .prepare(
              "UPDATE channel_endpoints SET selected_session_id = 'parent-session' WHERE id = ?",
            )
            .run(dadEndpoint.id),
        /FOREIGN KEY constraint failed/u,
      );
    } finally {
      foundation.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "real bwrap host test confines file tools, bash, env, network, sockets, and cgroups",
  { skip: process.env.HITCH_RUN_DAD_SANDBOX_TESTS !== "1", timeout: 60_000 },
  async () => {
    const fixture = await makeFixture();
    try {
      const probe = await request(fixture, "probe");
      assert.equal(probe.cwd, "/workspace");
      assert.deepEqual(probe.environmentKeys, [
        "HOME",
        "PATH",
        "PWD",
        "TMPDIR",
      ]);
      assert.equal(probe.hostHomeVisible, false);
      assert.equal(probe.networkNamespaceHasExternalInterface, false);
      assert.equal(probe.networkDenied, true);
      assert.equal(probe.inboxWritable, true);
      assert.equal(probe.publishVisible, false);

      assert.deepEqual(await request(fixture, "read", { path: "inside.txt" }), {
        text: "parent workspace\n",
      });
      assert.deepEqual(
        await request(fixture, "read", { path: "/inbox/incoming.txt" }),
        { text: "read-only inbound\n" },
      );
      await assertSandboxFailure(fixture, "read", {
        path: "../parent-host-auth-sentinel",
      });
      await assertSandboxFailure(fixture, "read", {
        path: "/workspace/inside.txt",
      });
      await assertSandboxFailure(fixture, "read", {
        path: fixture.hostSecret,
      });
      await assertSandboxFailure(fixture, "read", {
        path: join(fixture.dadWorkspace, "dad-private-sentinel"),
      });
      assert.deepEqual(
        await request(fixture, "read", { path: "same-uid-hardlink.txt" }),
        { text: "SYNTHETIC_PARENT_HOST_AUTH\n" },
      );
      // A regular file symlink is rejected by lstat; directory symlinks must
      // not expose the host target through ls/grep/find either.
      await assertSandboxFailure(fixture, "read", { path: "file-link" });
      await assertSandboxFailure(fixture, "read", { path: "directory-link" });
      await assertSandboxFailure(fixture, "ls", { path: "directory-link" });
      await assertSandboxFailure(fixture, "grep", {
        pattern: "HOST_DIRECTORY_SENTINEL",
        path: "directory-link",
      });
      await assertSandboxFailure(fixture, "find", {
        pattern: "outside.txt",
        path: "directory-link",
      });
      await assertSandboxFailure(fixture, "write", {
        path: "/inbox/no-write.txt",
        content: "must fail",
      });

      const shell = await request(fixture, "bash", {
        command: [
          "printf 'cwd=%s\\n' \"$PWD\"",
          "env | sort",
          `test ! -e ${fixture.hostSecret}`,
          `test ! -S ${fixture.hostSocket}`,
          `! grep -F SYNTHETIC_DAD_PRIVATE /workspace/dad-workspace/dad-private-sentinel`,
          "! timeout 2 bash -c '</dev/tcp/1.1.1.1/53'",
        ].join("; "),
      });
      assert.equal(shell.exitCode, 0);
      assert.match(String(shell.output), /cwd=\/workspace/u);
      assert.match(String(shell.output), /HOME=\/tmp/u);
      assert.doesNotMatch(String(shell.output), /SYNTHETIC_PARENT_HOST_AUTH/u);
      assert.doesNotMatch(String(shell.output), /SYNTHETIC_DAD_PRIVATE/u);
      assert.doesNotMatch(String(shell.output), /HITCH_SYNTHETIC_TOKEN/u);

      const aborted = new AbortController();
      const cancellation = request(
        fixture,
        "bash",
        { command: "sleep 30" },
        aborted.signal,
      );
      setTimeout(() => aborted.abort(), 250).unref();
      await assert.rejects(cancellation, /sandbox-failed|aborted/u);
      assert.equal(fixture.backend.activeSandboxUnitCount(), 0);
      assert.equal(existsSync(join(fixture.root, "sandbox.log")), true);
      const audit = readFileSync(join(fixture.root, "sandbox.log"), "utf8");
      assert.match(audit, /"cleanupConfirmed":true/u);
      assert.equal(
        lstatSync(join(fixture.workspace, "same-uid-hardlink.txt")).nlink,
        2,
      );
    } finally {
      cleanupFixture(fixture);
    }
  },
);

// Keep the host-only lane explicit: this test invokes only a random unitPrefix
// through the backend. It never calls NativePiRuntime.create, whose startup
// cleanup currently enumerates all hitch-p0-*.scope units for the UID.
