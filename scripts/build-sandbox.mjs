#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repository, "packages", "hitch-sandbox-extension");
const destination = join(repository, "dist", "sandbox");
mkdirSync(destination, { recursive: true, mode: 0o700 });

for (const name of [
  "hitch-sandbox.ts",
  "sandbox-backend.mjs",
  "sandbox-worker.mjs",
]) {
  const target = join(destination, name);
  rmSync(target, { force: true });
  copyFileSync(join(source, name), target);
  chmodSync(target, 0o444);
}

const temporary = join(destination, "secure-bwrap-helper.tmp");
const helper = join(destination, "secure-bwrap-helper");
rmSync(temporary, { force: true });
const compiler = spawnSync(
  "/usr/bin/cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(source, "secure-bwrap-helper.c"),
    "-o",
    temporary,
    "-lcrypto",
  ],
  {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  },
);
if (compiler.status !== 0) {
  rmSync(temporary, { force: true });
  throw new Error(
    `sandbox helper compilation failed: ${compiler.stderr.trim()}`,
  );
}
chmodSync(temporary, 0o555);
renameSync(temporary, helper);
