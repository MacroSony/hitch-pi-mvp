import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const MAX_STATE_BYTES = 1024 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export interface WeChatCredentials {
  readonly schemaVersion: 1;
  readonly authenticatedAccountId: string;
  readonly token: string;
  readonly baseUrl: string;
  readonly cdnBaseUrl: string;
}

interface RuntimeState {
  readonly schemaVersion: 1;
  readonly authenticatedAccountId: string;
  readonly cursor: string;
  readonly contexts: Readonly<Record<string, string>>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("WeChat state is invalid");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw new Error("WeChat state fields are invalid");
  }
  return record;
}

function text(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new Error(`WeChat ${label} is invalid`);
  }
  return value;
}

function endpoint(value: unknown, label: string): string {
  const parsed = text(value, label, 2048);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`WeChat ${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`WeChat ${label} is invalid`);
  }
  return url.toString().replace(/\/$/u, "");
}

function privateFile(path: string): void {
  const metadata = lstatSync(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size > BigInt(MAX_STATE_BYTES) ||
    (uid !== undefined && metadata.uid !== BigInt(uid)) ||
    (metadata.mode & 0o077n) !== 0n ||
    realpathSync(path) !== path
  ) {
    throw new Error("WeChat state file is unsafe");
  }
}

function privateDirectory(path: string): void {
  const metadata = lstatSync(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== BigInt(uid)) ||
    (metadata.mode & 0o077n) !== 0n ||
    realpathSync(path) !== path
  ) {
    throw new Error("WeChat state directory is unsafe");
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readJson(path: string): unknown {
  privateFile(path);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("WeChat state JSON is corrupt; repeat the attended login");
  }
}

function atomicJson(path: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES)
    throw new Error("WeChat state exceeds its bound");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(
    temporary,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(descriptor);
  chmodSync(temporary, 0o600);
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  syncDirectory(dirname(path));
}

export function writeWeChatCredentials(
  stateDirectory: string,
  credentials: WeChatCredentials,
): void {
  privateDirectory(stateDirectory);
  const validated: WeChatCredentials = {
    schemaVersion: 1,
    authenticatedAccountId: text(
      credentials.authenticatedAccountId,
      "authenticated account id",
      128,
    ),
    token: text(credentials.token, "bot token", 8192),
    baseUrl: endpoint(credentials.baseUrl, "API URL"),
    cdnBaseUrl: endpoint(credentials.cdnBaseUrl, "CDN URL"),
  };
  atomicJson(join(stateDirectory, "credentials.json"), validated);
  atomicJson(join(stateDirectory, "runtime.json"), {
    schemaVersion: 1,
    authenticatedAccountId: validated.authenticatedAccountId,
    cursor: "",
    contexts: {},
  } satisfies RuntimeState);
}

export class WeChatStateStore {
  readonly credentials: WeChatCredentials;
  readonly #runtimePath: string;
  #runtime: RuntimeState;

  public constructor(
    readonly localAccountId: string,
    readonly stateDirectory: string,
  ) {
    privateDirectory(stateDirectory);
    if (!existsSync(join(stateDirectory, "credentials.json")))
      throw new Error(
        "WeChat credentials are missing; run the attended WeChat login",
      );
    const input = exactRecord(
      readJson(join(stateDirectory, "credentials.json")),
      [
        "schemaVersion",
        "authenticatedAccountId",
        "token",
        "baseUrl",
        "cdnBaseUrl",
      ],
    );
    if (input.schemaVersion !== 1)
      throw new Error("WeChat credential schema is unsupported");
    this.credentials = {
      schemaVersion: 1,
      authenticatedAccountId: text(
        input.authenticatedAccountId,
        "authenticated account id",
        128,
      ),
      token: text(input.token, "bot token", 8192),
      baseUrl: endpoint(input.baseUrl, "API URL"),
      cdnBaseUrl: endpoint(input.cdnBaseUrl, "CDN URL"),
    };
    this.#runtimePath = join(stateDirectory, "runtime.json");
    this.#runtime = existsSync(this.#runtimePath)
      ? this.#parseRuntime(readJson(this.#runtimePath))
      : {
          schemaVersion: 1,
          authenticatedAccountId: this.credentials.authenticatedAccountId,
          cursor: "",
          contexts: {},
        };
  }

  #parseRuntime(value: unknown): RuntimeState {
    const input = exactRecord(value, [
      "schemaVersion",
      "authenticatedAccountId",
      "cursor",
      "contexts",
    ]);
    if (input.schemaVersion !== 1)
      throw new Error("WeChat runtime schema is unsupported");
    const authenticatedAccountId = text(
      input.authenticatedAccountId,
      "runtime account id",
      128,
    );
    if (authenticatedAccountId !== this.credentials.authenticatedAccountId)
      throw new Error(
        "WeChat runtime account does not match credentials; repeat the attended login",
      );
    if (
      input.contexts === null ||
      typeof input.contexts !== "object" ||
      Array.isArray(input.contexts)
    )
      throw new Error("WeChat context state is invalid");
    const contexts: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.contexts)) {
      text(key, "context binding", 512);
      contexts[key] = text(value, "context token", 64 * 1024);
    }
    const cursor =
      input.cursor === "" ? "" : text(input.cursor, "cursor", 64 * 1024);
    return {
      schemaVersion: 1,
      authenticatedAccountId,
      cursor,
      contexts,
    };
  }

  #binding(peerId: string): string {
    return JSON.stringify([
      this.localAccountId,
      this.credentials.authenticatedAccountId,
      text(peerId, "peer id", 128),
    ]);
  }

  public cursor(): string {
    return this.#runtime.cursor;
  }

  public context(peerId: string): string | undefined {
    return this.#runtime.contexts[this.#binding(peerId)];
  }

  public saveContext(peerId: string, token: string): void {
    this.commit(this.#runtime.cursor, [[peerId, token]]);
  }

  public saveCursor(cursor: string): void {
    this.commit(cursor, []);
  }

  public commit(
    cursor: string,
    contextUpdates: Iterable<readonly [peerId: string, token: string]>,
  ): void {
    const parsed = cursor === "" ? "" : text(cursor, "cursor", 64 * 1024);
    const contexts: Record<string, string> = { ...this.#runtime.contexts };
    for (const [peerId, token] of contextUpdates) {
      contexts[this.#binding(peerId)] = text(token, "context token", 64 * 1024);
    }
    const next: RuntimeState = {
      schemaVersion: 1,
      authenticatedAccountId: this.credentials.authenticatedAccountId,
      cursor: parsed,
      contexts,
    };
    atomicJson(this.#runtimePath, next);
    this.#runtime = next;
  }
}
