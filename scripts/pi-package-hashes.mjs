#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function treeSha256(root, includeDependencies) {
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      if (
        !includeDependencies &&
        prefix.length === 0 &&
        name === "node_modules"
      )
        continue;
      const absolute = join(directory, name);
      const child = prefix.length === 0 ? name : `${prefix}/${name}`;
      const metadata = lstatSync(absolute);
      if (metadata.isDirectory()) {
        hash.update(`d\0${child}\0`);
        visit(absolute, child);
      } else if (metadata.isSymbolicLink()) {
        hash.update(`l\0${child}\0${readlinkSync(absolute)}\0`);
      } else if (metadata.isFile()) {
        hash.update(`f\0${child}\0`);
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

const usage =
  "usage: node scripts/pi-package-hashes.mjs [pi-coding-agent-package-root]";
if (process.argv.length > 3) throw new Error(usage);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(
  process.argv[2] ??
    join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent"),
);
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
if (packageJson.name !== "@earendil-works/pi-coding-agent")
  throw new Error("package root is not @earendil-works/pi-coding-agent");

console.log(`package: ${packageJson.name}@${packageJson.version}`);
console.log(`tree-sha256: ${treeSha256(packageRoot, false)}`);
console.log(`dependency-closure-sha256: ${treeSha256(packageRoot, true)}`);
