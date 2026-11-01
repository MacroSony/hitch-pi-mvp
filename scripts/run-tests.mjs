#!/usr/bin/env node
// Run `node --test` under a per-run TMPDIR that is always removed afterwards.
// Many fixtures create os.tmpdir() workspaces without tearing them down; one
// owned root here keeps every run from leaking directories into /tmp.
// The root stays short (/tmp/hrt-XXXXXX) to respect Unix socket path limits.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync(join("/tmp", "hrt-"));
const cleanup = () => rmSync(root, { recursive: true, force: true });

const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", "--test", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, TMPDIR: root } },
);
const forward = (signal) => child.kill(signal);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, forward);
child.on("exit", (code, signal) => {
  cleanup();
  if (signal !== null) {
    process.exitCode = 1;
    console.error(`test runner terminated by ${signal}`);
  } else process.exitCode = code ?? 1;
});
child.on("error", (error) => {
  cleanup();
  console.error(error);
  process.exitCode = 1;
});
