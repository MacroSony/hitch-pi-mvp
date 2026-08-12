import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../src/config/config.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("operator assets describe the runnable bounded service", () => {
  const example = JSON.parse(
    readFileSync(resolve(repository, "config.example.json"), "utf8"),
  ) as unknown;
  const config = parseConfig(example);
  assert.equal(config.telegramAccounts.length, 1);
  assert.equal(config.wechatAccounts.length, 1);

  const unit = readFileSync(
    resolve(repository, "systemd/hitch-pi-mvp.service"),
    "utf8",
  );
  for (const required of [
    "ExecStart=/usr/bin/env /usr/local/bin/node",
    "--config /srv/hitch/config.json --channels",
    "UMask=0077",
    "NoNewPrivileges=true",
    "LockPersonality=true",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    "TasksMax=256",
    "MemoryMax=2G",
  ]) {
    assert.match(
      unit,
      new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  for (const incompatible of [
    "ProtectSystem=",
    "ProtectHome=",
    "ReadOnlyPaths=",
    "ReadWritePaths=",
    "PrivateTmp=",
    "RestrictSUIDSGID=",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
  ]) {
    assert.ok(!unit.includes(incompatible), incompatible);
  }
  assert.doesNotMatch(unit, /(?:bot|provider)[_-]?(?:token|key)\s*=/iu);

  const guide = readFileSync(
    resolve(repository, "docs/operator-guide.md"),
    "utf8",
  );
  for (const heading of [
    "## 1. Host prerequisites",
    "## 4. Authenticate outside chat",
    "## 6. User systemd service",
    "## 7. Attended concept acceptance",
    "## 8. Operations and recovery",
    "## 9. Known MVP limits",
    "## 10. Disable or completely reset",
  ]) {
    assert.ok(guide.includes(heading), heading);
  }
  assert.match(guide, /curl --config -/u);
  assert.match(guide, /userId=.*privateChatId=/u);
  assert.match(guide, /npm run acceptance:service/u);
});
