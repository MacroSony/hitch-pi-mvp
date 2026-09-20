import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoStartupSandboxScopes,
  cleanupOwnedSandboxScopes,
  inspectStartupSandboxScopes,
  listAllSandboxScopes,
  listOwnedSandboxScopes,
  type SandboxUnitCommandResult,
  type SandboxUnitExecutor,
} from "../src/pi/sandbox-units.js";

const OWNER_A = "aaaaaaaaaaaaaaaa";
const OWNER_B = "bbbbbbbbbbbbbbbb";
const DIGEST_1 = "0123456789abcdef01234567";
const DIGEST_2 = "89abcdef0123456789abcdef";

function scope(owner: string, digest: string): string {
  return `hitch-p0-${owner}-${digest}.scope`;
}

function success(stdout = ""): SandboxUnitCommandResult {
  return { status: 0, stdout };
}

test("owner-scoped enumeration filters foreign same-UID units", () => {
  const commands: string[][] = [];
  const execute: SandboxUnitExecutor = (arguments_) => {
    commands.push([...arguments_]);
    return success(
      `${scope(OWNER_A, DIGEST_1)}\n${scope(OWNER_B, DIGEST_2)}\n`,
    );
  };

  assert.deepEqual(listOwnedSandboxScopes(OWNER_A, execute), [
    scope(OWNER_A, DIGEST_1),
  ]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.[2], `hitch-p0-${OWNER_A}-*.scope`);
  assert.equal(
    commands.some((arguments_) =>
      arguments_.includes(scope(OWNER_B, DIGEST_2)),
    ),
    false,
  );
});

test("cleanup kills and stops only owner scopes and confirms they are empty", async () => {
  let listAttempts = 0;
  const mutationCommands: string[][] = [];
  const execute: SandboxUnitExecutor = (arguments_) => {
    if (arguments_[2] === `hitch-p0-${OWNER_A}-*.scope`) {
      listAttempts += 1;
      return success(
        listAttempts === 1
          ? `${scope(OWNER_A, DIGEST_1)}\n${scope(OWNER_B, DIGEST_2)}\n`
          : "",
      );
    }
    mutationCommands.push([...arguments_]);
    return success();
  };

  assert.equal(await cleanupOwnedSandboxScopes(OWNER_A, execute), true);
  assert.deepEqual(mutationCommands, [
    [
      "--user",
      "kill",
      "--kill-whom=all",
      "--signal=KILL",
      scope(OWNER_A, DIGEST_1),
    ],
    ["--user", "stop", scope(OWNER_A, DIGEST_1)],
  ]);
  assert.equal(
    mutationCommands.some((arguments_) =>
      arguments_.includes(scope(OWNER_B, DIGEST_2)),
    ),
    false,
  );
});

test("invalid owner prefixes never invoke systemctl", async () => {
  let calls = 0;
  const execute: SandboxUnitExecutor = () => {
    calls += 1;
    return success();
  };

  assert.equal(listOwnedSandboxScopes("not-a-prefix", execute), null);
  assert.equal(await cleanupOwnedSandboxScopes("not-a-prefix", execute), false);
  assert.equal(calls, 0);
});

test("identifies legacy and owner-scoped units before startup", () => {
  const legacy = `hitch-p0-${DIGEST_1}.scope`;
  assert.deepEqual(
    inspectStartupSandboxScopes(() =>
      success(`${scope(OWNER_A, DIGEST_1)}\n${legacy}\n`),
    ),
    {
      kind: "existing",
      units: [scope(OWNER_A, DIGEST_1), legacy],
    },
  );
  assert.equal(listAllSandboxScopes(() => success(""))?.length, 0);
  assert.equal(
    listAllSandboxScopes(() => ({ status: 1, stdout: "" })),
    null,
  );
});

test("startup fails closed on existing scopes without kill or stop commands", () => {
  const commands: string[][] = [];
  const execute: SandboxUnitExecutor = (arguments_) => {
    commands.push([...arguments_]);
    return success(`${scope(OWNER_A, DIGEST_1)}\n`);
  };

  assert.throws(
    () => assertNoStartupSandboxScopes(execute),
    /operator must verify and recover/u,
  );
  assert.deepEqual(commands, [
    [
      "--user",
      "list-units",
      "hitch-p0-*.scope",
      "--all",
      "--plain",
      "--no-legend",
      "--no-pager",
    ],
  ]);
});

test("startup fails closed on an unconfirmable scope state without commands", () => {
  const commands: string[][] = [];
  const execute: SandboxUnitExecutor = (arguments_) => {
    commands.push([...arguments_]);
    return { status: null, stdout: "" };
  };

  assert.throws(
    () => assertNoStartupSandboxScopes(execute),
    /operator must verify recovery/u,
  );
  assert.deepEqual(commands, [
    [
      "--user",
      "list-units",
      "hitch-p0-*.scope",
      "--all",
      "--plain",
      "--no-legend",
      "--no-pager",
    ],
  ]);

  assert.deepEqual(
    inspectStartupSandboxScopes(() => success("unexpected-line\n")),
    { kind: "unknown" },
  );
});

test("startup passes only when the read-only scope enumeration is empty", () => {
  const commands: string[][] = [];
  const execute: SandboxUnitExecutor = (arguments_) => {
    commands.push([...arguments_]);
    return success();
  };

  assert.doesNotThrow(() => assertNoStartupSandboxScopes(execute));
  assert.deepEqual(commands, [
    [
      "--user",
      "list-units",
      "hitch-p0-*.scope",
      "--all",
      "--plain",
      "--no-legend",
      "--no-pager",
    ],
  ]);
});
