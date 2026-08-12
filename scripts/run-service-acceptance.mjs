import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux" || process.getuid === undefined) {
  throw new Error("service acceptance requires Linux");
}
if (Number.parseInt(process.versions.node.split(".")[0] ?? "", 10) !== 24) {
  throw new Error("service acceptance requires Node 24");
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDirectory = `/run/user/${process.getuid()}`;
const unit = `hitch-service-acceptance-${process.pid}`;
const result = spawnSync(
  "/usr/bin/systemd-run",
  [
    "--user",
    "--wait",
    "--collect",
    "--pipe",
    `--unit=${unit}`,
    `--working-directory=${repository}`,
    "--property=NoNewPrivileges=yes",
    "--property=LockPersonality=yes",
    "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    "--property=LimitNOFILE=4096",
    "--property=TasksMax=256",
    "--property=MemoryMax=2G",
    "--property=UMask=0077",
    "--setenv=HITCH_RUN_SANDBOX_TESTS=1",
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    "--test",
    "dist/test/native-runtime.test.js",
  ],
  {
    cwd: repository,
    env: {
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: runtimeDirectory,
    },
    stdio: "inherit",
    timeout: 120_000,
  },
);

if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  throw new Error(`service-constrained acceptance failed (${result.status})`);
}
