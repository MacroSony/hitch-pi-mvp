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
const webSource = join(repository, "packages", "hitch-web-search-extension");
const destination = join(repository, "dist", "sandbox");
mkdirSync(destination, { recursive: true, mode: 0o700 });

for (const [from, name] of [
  [join(source, "hitch-sandbox.ts"), "hitch-sandbox.ts"],
  [join(webSource, "pi-web-search.ts"), "pi-web-search.ts"],
  [join(source, "sandbox-backend.mjs"), "sandbox-backend.mjs"],
  [join(source, "sandbox-worker.mjs"), "sandbox-worker.mjs"],
]) {
  const target = join(destination, name);
  rmSync(target, { force: true });
  copyFileSync(from, target);
  chmodSync(target, 0o444);
}

const webSearchDestination = join(destination, "web-search");
const egressDestination = join(destination, "egress");
mkdirSync(webSearchDestination, { recursive: true, mode: 0o700 });
mkdirSync(egressDestination, { recursive: true, mode: 0o700 });
for (const [from, to] of [
  [
    join(repository, "dist", "src", "web-search", "tavily.js"),
    join(webSearchDestination, "tavily.js"),
  ],
  [
    join(repository, "dist", "src", "egress", "client.js"),
    join(egressDestination, "client.js"),
  ],
]) {
  rmSync(to, { force: true });
  copyFileSync(from, to);
  chmodSync(to, 0o444);
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
