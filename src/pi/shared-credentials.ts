import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { chmod, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = Exclude<
  Awaited<ReturnType<CredentialStore["read"]>>,
  undefined
>;
type CredentialInfo = Awaited<ReturnType<CredentialStore["list"]>>[number];
type AuthData = Record<string, Credential>;

type LockRelease = () => Promise<void>;
type LockOptions = {
  readonly realpath: false;
  readonly retries: 0;
  readonly stale: number;
  readonly onCompromised: (error: unknown) => void;
};
type ProperLockfile = {
  lock(path: string, options: LockOptions): Promise<LockRelease>;
};

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as ProperLockfile;

const MAX_AUTH_BYTES = 1024 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 30_000;
const STORAGE_ERROR = "shared credential storage failure";
const ABORT_ERROR = "shared credential operation aborted";

/** A provider callback failed before a credential mutation; never contains its body. */
export class SharedCredentialUpdateError extends Error {
  public constructor() {
    super("shared credential update callback failed");
    this.name = "SharedCredentialUpdateError";
  }
}

function storageError(): Error {
  return new Error(STORAGE_ERROR);
}

function abortError(): Error {
  const error = new Error(ABORT_ERROR);
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

function ownerUid(): bigint | undefined {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : BigInt(uid);
}

function isPrivateDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(path, { bigint: true });
    return (
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      (ownerUid() === undefined || metadata.uid === ownerUid()) &&
      (metadata.mode & 0o077n) === 0n &&
      realpathSync(path) === path
    );
  } catch {
    return false;
  }
}

function isPrivateRegularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path, { bigint: true });
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1n &&
      (ownerUid() === undefined || metadata.uid === ownerUid()) &&
      (metadata.mode & 0o077n) === 0n &&
      metadata.size <= BigInt(MAX_AUTH_BYTES) &&
      realpathSync(path) === path
    );
  } catch {
    return false;
  }
}

function validatePathShape(filePath: string): string {
  if (typeof filePath !== "string" || !isAbsolute(filePath))
    throw storageError();
  const absolute = resolve(filePath);
  if (absolute !== filePath || !isPrivateDirectory(dirname(filePath)))
    throw storageError();
  if (!isPrivateRegularFile(filePath)) throw storageError();
  return filePath;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isCredential(value: unknown): value is Credential {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    return (
      (candidate.key === undefined || typeof candidate.key === "string") &&
      (candidate.env === undefined || isStringRecord(candidate.env))
    );
  }
  return (
    candidate.type === "oauth" &&
    typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.expires === "number" &&
    Number.isFinite(candidate.expires)
  );
}

function parseAuth(content: string): AuthData {
  if (Buffer.byteLength(content, "utf8") > MAX_AUTH_BYTES) throw storageError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw storageError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw storageError();
  const result: AuthData = Object.create(null) as AuthData;
  for (const [providerId, credential] of Object.entries(parsed)) {
    if (!isCredential(credential)) throw storageError();
    result[providerId] = structuredClone(credential);
  }
  return result;
}

/** Validate the canonical, owner-private Pi auth.json path without creating it. */
export function validateSharedAuthPath(filePath: string): string {
  const canonical = validatePathShape(filePath);
  try {
    const content = readFileSync(canonical, "utf8");
    parseAuth(content);
  } catch {
    throw storageError();
  }
  return canonical;
}

async function readAuth(
  filePath: string,
  signal?: AbortSignal,
): Promise<AuthData> {
  checkAbort(signal);
  validatePathShape(filePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW protects the final component even if it changes after lstat.
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1n ||
      (ownerUid() !== undefined && metadata.uid !== ownerUid()) ||
      (metadata.mode & 0o077n) !== 0n ||
      metadata.size > BigInt(MAX_AUTH_BYTES)
    )
      throw storageError();
    const content = await handle.readFile({ encoding: "utf8" });
    checkAbort(signal);
    return parseAuth(content);
  } catch (error) {
    if (isAbort(error)) throw abortError();
    throw storageError();
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // A read failure is already content-free; never expose close details.
      }
    }
  }
}

function appendLiteral(
  parts: Array<
    { kind: "literal"; value: string } | { kind: "env"; name: string }
  >,
  value: string,
): void {
  if (value.length === 0) return;
  const previous = parts.at(-1);
  if (previous?.kind === "literal") previous.value += value;
  else parts.push({ kind: "literal", value });
}

function resolveApiKeyTemplate(
  config: string,
  providerEnv: Record<string, string> | undefined,
): string | undefined {
  const parts: Array<
    { kind: "literal"; value: string } | { kind: "env"; name: string }
  > = [];
  const name = /^[A-Za-z_][A-Za-z0-9_]*/u;
  const fullName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf("$", index);
    if (dollar < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollar));
    const next = config[dollar + 1];
    if (next === "$" || next === "!") {
      appendLiteral(parts, next);
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", dollar + 2);
      if (end < 0) {
        appendLiteral(parts, "$");
        index = dollar + 1;
        continue;
      }
      const variable = config.slice(dollar + 2, end);
      if (fullName.test(variable)) parts.push({ kind: "env", name: variable });
      else appendLiteral(parts, config.slice(dollar, end + 1));
      index = end + 1;
      continue;
    }
    const match = config.slice(dollar + 1).match(name);
    if (match?.[0] !== undefined) {
      parts.push({ kind: "env", name: match[0] });
      index = dollar + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollar + 1;
  }
  let resolved = "";
  for (const part of parts) {
    if (part.kind === "literal") resolved += part.value;
    else {
      const value = providerEnv?.[part.name] || process.env[part.name];
      if (value === undefined) return undefined;
      resolved += value;
    }
  }
  return resolved;
}

function exposedCredential(credential: Credential): Credential {
  const result = structuredClone(credential);
  if (result.type !== "api_key" || result.key === undefined) return result;
  if (result.key.startsWith("!")) throw storageError();
  const key = resolveApiKeyTemplate(result.key, result.env);
  if (key === undefined) throw storageError();
  result.key = key;
  return result;
}

function lockCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await sleep(
      delayMs,
      undefined,
      signal === undefined ? undefined : { signal },
    );
  } catch {
    checkAbort(signal);
    throw storageError();
  }
}

export class SharedCredentialStore implements CredentialStore {
  readonly #authPath: string;

  public constructor(filePath: string) {
    this.#authPath = validateSharedAuthPath(filePath);
  }

  async #withLock<T>(
    operation: (
      signal: AbortSignal | undefined,
      compromised: () => boolean,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    checkAbort(signal);
    let release: LockRelease | undefined;
    let compromised = false;
    const deadline = Date.now() + LOCK_WAIT_MS;
    const options: LockOptions = {
      realpath: false,
      retries: 0,
      stale: LOCK_STALE_MS,
      onCompromised: () => {
        compromised = true;
      },
    };
    let result: T | undefined;
    let failure: Error | undefined;
    try {
      for (;;) {
        checkAbort(signal);
        if (Date.now() >= deadline) throw storageError();
        try {
          release = await lockfile.lock(this.#authPath, options);
          break;
        } catch (error) {
          checkAbort(signal);
          if (lockCode(error) !== "ELOCKED" || Date.now() >= deadline)
            throw storageError();
          await waitForRetry(
            Math.min(50, Math.max(1, deadline - Date.now())),
            signal,
          );
        }
      }
      if (compromised) throw storageError();
      result = await operation(signal, () => compromised);
      if (compromised) throw storageError();
      checkAbort(signal);
    } catch (error) {
      failure =
        isAbort(error) || signal?.aborted === true
          ? abortError()
          : error instanceof SharedCredentialUpdateError
            ? error
            : storageError();
    } finally {
      if (release !== undefined) {
        try {
          await release();
        } catch {
          failure = storageError();
        }
      }
    }
    if (failure !== undefined) throw failure;
    if (compromised) throw storageError();
    return result as T;
  }

  public async read(
    providerId: string,
    options?: Parameters<CredentialStore["read"]>[1],
  ): Promise<Credential | undefined> {
    try {
      const data = await readAuth(this.#authPath, options?.signal);
      const credential = data[providerId];
      return credential === undefined
        ? undefined
        : exposedCredential(credential);
    } catch (error) {
      if (isAbort(error) || options?.signal?.aborted === true)
        throw abortError();
      throw storageError();
    }
  }

  public async list(
    options?: Parameters<CredentialStore["list"]>[0],
  ): Promise<readonly CredentialInfo[]> {
    try {
      const data = await readAuth(this.#authPath, options?.signal);
      const result: CredentialInfo[] = [];
      for (const [providerId, credential] of Object.entries(data))
        result.push({ providerId, type: credential.type });
      return result;
    } catch (error) {
      if (isAbort(error) || options?.signal?.aborted === true)
        throw abortError();
      throw storageError();
    }
  }

  public async modify(
    providerId: string,
    fn: Parameters<CredentialStore["modify"]>[1],
    options?: Parameters<CredentialStore["modify"]>[2],
  ): Promise<Credential | undefined> {
    return this.#withLock(async (signal, compromised) => {
      const data = await readAuth(this.#authPath, signal);
      const current = data[providerId];
      let next: Credential | undefined;
      try {
        next = await fn(
          current === undefined ? undefined : structuredClone(current),
        );
      } catch (error) {
        if (isAbort(error) || signal?.aborted === true) throw abortError();
        throw new SharedCredentialUpdateError();
      }
      checkAbort(signal);
      if (compromised()) throw storageError();
      if (next === undefined)
        return current === undefined ? undefined : structuredClone(current);
      if (!isCredential(next)) throw storageError();
      data[providerId] = structuredClone(next);
      await atomicWrite(this.#authPath, data, () => {
        checkAbort(signal);
        if (compromised()) throw storageError();
      });
      if (compromised()) throw storageError();
      return structuredClone(next);
    }, options?.signal);
  }

  public async delete(
    providerId: string,
    options?: Parameters<CredentialStore["delete"]>[1],
  ): Promise<void> {
    await this.#withLock(async (signal, compromised) => {
      const data = await readAuth(this.#authPath, signal);
      delete data[providerId];
      checkAbort(signal);
      if (compromised()) throw storageError();
      await atomicWrite(this.#authPath, data, () => {
        checkAbort(signal);
        if (compromised()) throw storageError();
      });
      if (compromised()) throw storageError();
      return undefined;
    }, options?.signal);
  }
}

async function atomicWrite(
  filePath: string,
  data: AuthData,
  checkCommit: () => void,
): Promise<void> {
  validatePathShape(filePath);
  let encoded: string;
  try {
    encoded = `${JSON.stringify(data, null, 2)}\n`;
  } catch {
    throw storageError();
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_AUTH_BYTES) throw storageError();

  const directory = dirname(filePath);
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    temporaryHandle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await chmod(temporary, 0o600);
    const temporaryMetadata = await temporaryHandle.stat({ bigint: true });
    if (
      !temporaryMetadata.isFile() ||
      temporaryMetadata.nlink !== 1n ||
      (ownerUid() !== undefined && temporaryMetadata.uid !== ownerUid()) ||
      (temporaryMetadata.mode & 0o077n) !== 0n
    )
      throw storageError();
    await temporaryHandle.writeFile(encoded, { encoding: "utf8" });
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    checkCommit();
    await rename(temporary, filePath);
    renamed = true;

    const directoryHandle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    throw storageError();
  } finally {
    if (temporaryHandle !== undefined) {
      try {
        await temporaryHandle.close();
      } catch {
        // The operation is already failed and remains content-free.
      }
    }
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch {
        // There may be no temporary file after an early open failure.
      }
    }
  }
}
