import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_PROFILE_JSON_BYTES = 1024 * 1024;
const MANAGED_FILES = ["settings.json", "models.json"] as const;
const CACHE_FILES = ["models-store.json"] as const;

function ownerUid(): bigint | undefined {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : BigInt(uid);
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path, { bigint: true });
  const uid = ownerUid();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077n) !== 0n ||
    realpathSync(path) !== path
  ) {
    throw new Error("native Pi runtime directory is unsafe");
  }
}

export function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function validateJsonFile(path: string): void {
  if (!existsSync(path)) return;
  const metadata = lstatSync(path, { bigint: true });
  const uid = ownerUid();
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    metadata.isSymbolicLink() ||
    metadata.size > BigInt(MAX_PROFILE_JSON_BYTES) ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077n) !== 0n
  ) {
    throw new Error("Pi profile contains an unsafe JSON file");
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (record(parsed) === null) throw new Error("not an object");
  } catch {
    throw new Error(
      "Pi profile JSON is corrupt; restore the operator backup or log in again",
    );
  }
}

export function validatePiProfile(piProfileDir: string): void {
  privateDirectory(piProfileDir);
  for (const name of [
    "auth.json",
    "models.json",
    "models-store.json",
    "settings.json",
  ]) {
    validateJsonFile(join(piProfileDir, name));
  }
}

export function normalizeProfilePermissions(piProfileDir: string): void {
  privateDirectory(piProfileDir);
  for (const name of readdirSync(piProfileDir)) {
    if (name === "auth.json") continue;
    const child = join(piProfileDir, name);
    const metadata = lstatSync(child, { bigint: true });
    if (metadata.isDirectory()) {
      chmodSync(child, 0o700);
      normalizeProfilePermissions(child);
    } else if (metadata.isFile()) {
      chmodSync(child, 0o600);
    } else if (metadata.isSymbolicLink()) {
      throw new Error("Pi profile contains a symbolic link");
    }
  }
}

export function preparePiProfile(
  sourceProfileDir: string,
  targetProfileDir: string,
): void {
  privateDirectory(targetProfileDir);

  for (const name of MANAGED_FILES) {
    const sourcePath = join(sourceProfileDir, name);
    const targetPath = join(targetProfileDir, name);
    if (existsSync(sourcePath)) {
      validateJsonFile(sourcePath);
      // Check before opening a retained target: never follow a stale link.
      if (existsSync(targetPath)) validateJsonFile(targetPath);
      else {
        try {
          lstatSync(targetPath);
          throw new Error("Pi profile target is unsafe");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const content = readFileSync(sourcePath);
      writeFileSync(targetPath, content, {
        mode: 0o600,
        flag: existsSync(targetPath) ? "w" : "wx",
      });
      chmodSync(targetPath, 0o600);
    } else if (existsSync(targetPath)) {
      rmSync(targetPath, { force: true });
    }
  }

  for (const name of CACHE_FILES) {
    const sourcePath = join(sourceProfileDir, name);
    const targetPath = join(targetProfileDir, name);
    if (!existsSync(targetPath) && existsSync(sourcePath)) {
      validateJsonFile(sourcePath);
      // Check before opening a retained target: never follow a stale link.
      if (existsSync(targetPath)) validateJsonFile(targetPath);
      else {
        try {
          lstatSync(targetPath);
          throw new Error("Pi profile target is unsafe");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const content = readFileSync(sourcePath);
      writeFileSync(targetPath, content, {
        mode: 0o600,
        flag: existsSync(targetPath) ? "w" : "wx",
      });
      chmodSync(targetPath, 0o600);
    }
  }

  normalizeProfilePermissions(targetProfileDir);
}

export interface PreparedProfiles {
  readonly profiles: ReadonlyMap<string, string>;
  readonly catalogProfile: string;
}

export function preparePiProfiles(
  sourceProfileDir: string,
  profileRoot: string,
  userIds?: readonly string[],
): PreparedProfiles {
  validatePiProfile(sourceProfileDir);
  privateDirectory(profileRoot);

  const configuredUsers = userIds ?? [];
  const uniqueUsers = new Set(configuredUsers);
  if (uniqueUsers.size !== configuredUsers.length) {
    throw new Error("duplicate Pi profile user id");
  }

  const profiles = new Map<string, string>();
  let catalogProfile: string;

  if (configuredUsers.length === 0) {
    catalogProfile = join(profileRoot, "default");
    preparePiProfile(sourceProfileDir, catalogProfile);
  } else {
    for (const userId of configuredUsers) {
      const segment = safeSegment(userId, "Pi profile user id");
      if (profiles.has(segment)) {
        throw new Error("duplicate Pi profile user id");
      }
      const directory = join(profileRoot, segment);
      preparePiProfile(sourceProfileDir, directory);
      profiles.set(segment, directory);
    }
    const first = profiles.values().next().value;
    if (first === undefined) {
      throw new Error("at least one user is required for a native Pi runtime");
    }
    catalogProfile = first;
  }

  return { profiles, catalogProfile };
}
