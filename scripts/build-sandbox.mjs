#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repository, "packages", "hitch-sandbox-extension");
const webSource = join(repository, "packages", "hitch-web-search-extension");
const antigravitySource = join(
  repository,
  "packages",
  "hitch-antigravity-extension",
);
const destination = join(repository, "dist", "sandbox");
mkdirSync(destination, { recursive: true, mode: 0o700 });

// The sandbox extension's tool-definition table is the single source of
// truth for the static tool list. Keep the literal ["name", "..."] format
// in hitch-sandbox.ts: this extractor depends on it.
const sandboxSource = readFileSync(join(source, "hitch-sandbox.ts"), "utf8");
const staticTools = [...sandboxSource.matchAll(/\t\["([a-z_]+)",/g)].map(
  (match) => match[1],
);
if (staticTools.length === 0)
  throw new Error("failed to extract static tool list from hitch-sandbox.ts");

for (const [from, name] of [
  [join(source, "hitch-sandbox.ts"), "hitch-sandbox.ts"],
  [join(source, "manifest-attest.mjs"), "manifest-attest.mjs"],
  [join(webSource, "pi-web-search.ts"), "pi-web-search.ts"],
  [join(antigravitySource, "pi-antigravity.ts"), "pi-antigravity.ts"],
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

// Build-generated tool manifest: the runtime reads this instead of
// hardcoded tool lists and asset digests. Operator-controlled tool policy
// (optional tools, dynamic sources, per-profile restrictions) is layered
// on top at turn time; this file anchors what the build actually shipped.
const assets = {};
for (const name of [
  "hitch-sandbox.ts",
  "manifest-attest.mjs",
  "pi-web-search.ts",
  "pi-antigravity.ts",
  "sandbox-backend.mjs",
  "sandbox-worker.mjs",
  "secure-bwrap-helper",
  "web-search/tavily.js",
  "egress/client.js",
]) {
  assets[name] = createHash("sha256")
    .update(readFileSync(join(destination, name)))
    .digest("hex");
}
const manifest = {
  schemaVersion: 1,
  staticTools,
  optionalTools: { web_search: { asset: "pi-web-search.ts" } },
  assets,
};
const manifestPath = join(destination, "tools-manifest.json");
rmSync(manifestPath, { force: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o444,
});
chmodSync(manifestPath, 0o444);
