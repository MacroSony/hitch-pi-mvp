import { spawnSync } from "node:child_process";

export const SANDBOX_OWNER_PREFIX_PATTERN = /^[a-f0-9]{16}$/u;
export const SANDBOX_SCOPE_NAME_PATTERN =
  /^hitch-p0-(?:[a-f0-9]{24}|[a-f0-9]{16}-[a-f0-9]{24})\.scope$/u;

const SYSTEMCTL = "/usr/bin/systemctl";
const SYSTEMCTL_TIMEOUT_MS = 5_000;
const SANDBOX_SCOPE_GLOB = "hitch-p0-*.scope";
const CLEANUP_MAX_ATTEMPTS = 100;
const CLEANUP_RETRY_DELAY_MS = 20;

export interface SandboxUnitCommandResult {
  readonly status: number | null;
  readonly stdout: string;
}

export type SandboxUnitExecutor = (
  arguments_: readonly string[],
) => SandboxUnitCommandResult;

export type StartupSandboxInspection =
  | { readonly kind: "empty" }
  | { readonly kind: "existing"; readonly units: readonly string[] }
  | { readonly kind: "unknown" };

function systemdEnvironment(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("native Pi requires a Unix service user");
  const runtime = `/run/user/${uid}`;
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
}

function runSystemctl(arguments_: readonly string[]): SandboxUnitCommandResult {
  const result = spawnSync(SYSTEMCTL, arguments_, {
    encoding: "utf8",
    env: systemdEnvironment(),
    timeout: SYSTEMCTL_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
  };
}

function unitNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s/u)[0])
    .filter((unit): unit is string => unit !== undefined && unit.length > 0);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function isSandboxOwnerPrefix(prefix: string): boolean {
  return SANDBOX_OWNER_PREFIX_PATTERN.test(prefix);
}

export function listOwnedSandboxScopes(
  prefix: string,
  execute: SandboxUnitExecutor = runSystemctl,
): readonly string[] | null {
  if (!isSandboxOwnerPrefix(prefix)) return null;
  const result = execute([
    "--user",
    "list-units",
    `hitch-p0-${prefix}-*.scope`,
    "--all",
    "--plain",
    "--no-legend",
    "--no-pager",
  ]);
  if (result.status !== 0) return null;
  const pattern = new RegExp(`^hitch-p0-${prefix}-[a-f0-9]{24}\\.scope$`, "u");
  return [
    ...new Set(unitNames(result.stdout).filter((unit) => pattern.test(unit))),
  ];
}

export function listAllSandboxScopes(
  execute: SandboxUnitExecutor = runSystemctl,
): readonly string[] | null {
  const result = execute([
    "--user",
    "list-units",
    SANDBOX_SCOPE_GLOB,
    "--all",
    "--plain",
    "--no-legend",
    "--no-pager",
  ]);
  if (result.status !== 0) return null;
  return unitNames(result.stdout);
}

export function inspectStartupSandboxScopes(
  execute: SandboxUnitExecutor = runSystemctl,
): StartupSandboxInspection {
  const units = listAllSandboxScopes(execute);
  if (units === null) return { kind: "unknown" };
  const matching = units.filter((unit) =>
    SANDBOX_SCOPE_NAME_PATTERN.test(unit),
  );
  if (matching.length > 0) return { kind: "existing", units: matching };
  if (units.length > 0) return { kind: "unknown" };
  return { kind: "empty" };
}

export function assertNoStartupSandboxScopes(
  execute: SandboxUnitExecutor = runSystemctl,
): void {
  const inspection = inspectStartupSandboxScopes(execute);
  if (inspection.kind === "existing")
    throw new Error(
      "sandbox scopes exist before startup; operator must verify and recover them explicitly",
    );
  if (inspection.kind === "unknown")
    throw new Error(
      "sandbox scope state could not be confirmed before startup; operator must verify recovery",
    );
}

export async function cleanupOwnedSandboxScopes(
  prefix: string,
  execute: SandboxUnitExecutor = runSystemctl,
): Promise<boolean> {
  if (!isSandboxOwnerPrefix(prefix)) return false;
  for (let attempt = 0; attempt < CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    const units = listOwnedSandboxScopes(prefix, execute);
    if (units === null) return false;
    if (units.length === 0) return true;
    for (const unit of units) {
      execute(["--user", "kill", "--kill-whom=all", "--signal=KILL", unit]);
      execute(["--user", "stop", unit]);
    }
    await delay(CLEANUP_RETRY_DELAY_MS);
  }
  return false;
}
