import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  statSync,
  unlinkSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import { readRequiredSecret } from "../config/config.js";
import {
  LOCAL_METHODS,
  LocalControlError,
  type LocalCallerConfig,
  type LocalHandler,
  type LocalMethod,
  type LocalRequest,
} from "./types.js";

/** One JSONL request is capped at 64 KiB before the transport rejects it. */
export const LOCAL_REQUEST_MAX_BYTES = 64 * 1024;
/** Response payloads are bounded so a handler cannot hold the connection open. */
export const LOCAL_RESPONSE_MAX_BYTES = 1024 * 1024;
/** The whole request/handler/response exchange must finish within five seconds. */
export const LOCAL_REQUEST_TIMEOUT_MS = 5_000;
/** A hard cap on simultaneous private-socket clients. */
export const LOCAL_MAX_CONNECTIONS = 16;
/** Operator keys must be generated randomly and be at least this many bytes. */
export const LOCAL_MIN_TOKEN_BYTES = 32;
/** Operator keys above this size are rejected rather than hashed without bound. */
export const LOCAL_MAX_TOKEN_BYTES = 4 * 1024;
const CALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SOCKET_FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const STALE_PROBE_TIMEOUT_MS = 1_000;
const CLOSE_GRACE_MS = 250;
const RESPONSE_LINGER_MS = 500;

const DUMMY_DIGEST = createHash("sha256")
  .update("hitch-local-control-unauthenticated", "utf8")
  .digest();

interface SocketIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface AuthenticatedCaller {
  readonly config: LocalCallerConfig;
  readonly digest: Buffer;
}

type ProbeOutcome = "active" | "refused" | "gone";

type ErrorCode = LocalControlError["code"];

interface ServerErrorResponse {
  readonly v: 1;
  readonly ok: false;
  readonly error: ErrorCode;
}

interface ServerSuccessResponse {
  readonly v: 1;
  readonly ok: true;
  readonly result: unknown;
}

export interface LocalControlServerOptions {
  /** Must be the fixed `<dataRoot>/control/hitch.sock` path. */
  readonly socketPath: string;
  readonly callers: readonly LocalCallerConfig[];
  readonly handler: LocalHandler;
  /** Secret lookup environment; defaults to `process.env`. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxConnections?: number;
}

/** The single fixed owner-private control endpoint for this data root. */
export function controlSocketPath(dataRoot: string): string {
  return join(dataRoot, "control", "hitch.sock");
}

/**
 * Checks only the configured operator-key byte bounds. Character-frequency
 * statistics cannot establish cryptographic entropy; callers must provide
 * randomly generated keys of at least {@link LOCAL_MIN_TOKEN_BYTES} bytes.
 */
export function isValidLocalTokenLength(token: string): boolean {
  const bytes = Buffer.byteLength(token, "utf8");
  return bytes >= LOCAL_MIN_TOKEN_BYTES && bytes <= LOCAL_MAX_TOKEN_BYTES;
}

function refuse(message: string): Error {
  return new Error(message);
}

/** Walks every existing path component and refuses any symlink. */
function assertNoSymlinkComponents(target: string): void {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  const components = absolute
    .slice(root.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    let metadata: Stats;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw refuse("local control path contains a symlink component");
    }
  }
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const metadata = statSync(directory);
  if (!metadata.isDirectory()) {
    throw refuse("local control parent is not a directory");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw refuse("local control parent is not owned by the current user");
  }
  chmodSync(directory, DIRECTORY_MODE);
}

function socketIdentity(socketPath: string): SocketIdentity | null {
  let metadata: BigIntStats;
  try {
    metadata = lstatSync(socketPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw refuse("refusing to replace a symlinked local control path");
  }
  if (!metadata.isSocket()) {
    throw refuse("refusing to replace a non-socket local control path");
  }
  return { device: metadata.dev, inode: metadata.ino };
}

function probeStaleSocket(socketPath: string): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolveProbe) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const socket = createConnection({ path: socketPath });
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      socket.destroy();
      resolveProbe(outcome);
    };
    timer = setTimeout(() => finish("active"), STALE_PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED") finish("refused");
      else if (code === "ENOENT") finish("gone");
      else finish("active");
    });
  });
}

/**
 * A socket file is unlinked only when a probe proves ECONNREFUSED and the
 * inode still matches the one observed before the probe. Anything else is
 * treated as a live socket and left alone.
 */
async function removeStaleSocket(socketPath: string): Promise<void> {
  const before = socketIdentity(socketPath);
  if (before === null) return;
  const outcome = await probeStaleSocket(socketPath);
  if (outcome === "gone") return;
  if (outcome !== "refused") {
    throw refuse("local control socket is active; refusing to replace it");
  }
  const after = socketIdentity(socketPath);
  if (
    after === null ||
    after.device !== before.device ||
    after.inode !== before.inode
  ) {
    throw refuse("local control socket changed during stale cleanup");
  }
  unlinkSync(socketPath);
}

export class LocalControlServer {
  readonly #socketPath: string;
  readonly #callers: readonly LocalCallerConfig[];
  readonly #handler: LocalHandler;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #requestTimeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxConnections: number;
  #authenticators = new Map<string, AuthenticatedCaller>();
  #server: Server | null = null;
  #clients = new Set<Socket>();
  #ownedIdentity: SocketIdentity | null = null;
  #listening = false;
  #closePromise: Promise<void> | null = null;

  public constructor(options: LocalControlServerOptions) {
    if (
      !isAbsolute(options.socketPath) ||
      resolve(options.socketPath) !== options.socketPath
    ) {
      throw refuse(
        "local control socket path must be a normalized absolute path",
      );
    }
    this.#socketPath = options.socketPath;
    this.#callers = options.callers;
    this.#handler = options.handler;
    this.#environment = options.environment ?? process.env;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS;
    this.#maxRequestBytes = options.maxRequestBytes ?? LOCAL_REQUEST_MAX_BYTES;
    this.#maxResponseBytes =
      options.maxResponseBytes ?? LOCAL_RESPONSE_MAX_BYTES;
    this.#maxConnections = options.maxConnections ?? LOCAL_MAX_CONNECTIONS;
    for (const [label, value] of [
      ["requestTimeoutMs", this.#requestTimeoutMs],
      ["maxRequestBytes", this.#maxRequestBytes],
      ["maxResponseBytes", this.#maxResponseBytes],
      ["maxConnections", this.#maxConnections],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw refuse(`local control ${label} must be a positive integer`);
      }
    }
  }

  public get socketPath(): string {
    return this.#socketPath;
  }

  public get listening(): boolean {
    return this.#listening;
  }

  /** Loads each caller secret exactly once and keeps only its SHA-256 digest. */
  #loadCallers(): void {
    const authenticators = new Map<string, AuthenticatedCaller>();
    for (const caller of this.#callers) {
      const token = readRequiredSecret(caller.tokenEnv, this.#environment);
      if (!isValidLocalTokenLength(token)) {
        throw refuse(
          `local control token for caller ${caller.id} must be ${LOCAL_MIN_TOKEN_BYTES}..${LOCAL_MAX_TOKEN_BYTES} UTF-8 bytes`,
        );
      }
      authenticators.set(caller.id, {
        config: caller,
        digest: createHash("sha256").update(token, "utf8").digest(),
      });
    }
    this.#authenticators = authenticators;
  }

  public async listen(): Promise<void> {
    if (this.#listening) return;
    if (this.#closePromise !== null) {
      throw refuse("local control server has already been closed");
    }
    if (this.#server !== null) {
      throw refuse("local control server has already been started");
    }
    this.#loadCallers();

    const directory = dirname(this.#socketPath);
    assertNoSymlinkComponents(this.#socketPath);
    ensurePrivateDirectory(directory);
    assertNoSymlinkComponents(this.#socketPath);
    await removeStaleSocket(this.#socketPath);
    if (this.#closePromise !== null) {
      throw refuse("local control server has already been closed");
    }

    const server = createServer({ allowHalfOpen: true }, (socket) => {
      this.#onConnection(socket);
    });
    server.maxConnections = this.#maxConnections;
    this.#server = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      const onListening = (): void => {
        server.off("error", onError);
        resolveListen();
      };
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(this.#socketPath);
    });

    if (this.#closePromise !== null) {
      const identity = socketIdentity(this.#socketPath);
      await new Promise<void>((resolveClose) => {
        if (server.listening) server.close(() => resolveClose());
        else resolveClose();
      });
      this.#server = null;
      if (identity !== null) this.#unlinkOwnedSocket(identity);
      throw refuse("local control server has already been closed");
    }

    try {
      chmodSync(this.#socketPath, SOCKET_FILE_MODE);
      const identity = socketIdentity(this.#socketPath);
      if (identity === null) {
        throw refuse("local control socket was not created");
      }
      const metadata = statSync(this.#socketPath);
      const uid = process.getuid?.();
      if (uid !== undefined && metadata.uid !== uid) {
        throw refuse("local control socket is not owned by the current user");
      }
      this.#ownedIdentity = identity;
      this.#listening = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise === null) {
      this.#closePromise = this.#close();
    }
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#listening = false;
    const server = this.#server;
    this.#server = null;

    const clients = [...this.#clients];
    this.#clients.clear();
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // The socket may already be gone; cleanup below still destroys it.
      }
    }
    const pending = clients
      .filter((client) => !client.destroyed)
      .map(
        (client) =>
          new Promise<void>((resolveClient) => {
            client.once("close", () => resolveClient());
          }),
      );
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, CLOSE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    for (const client of clients) {
      try {
        client.destroy();
      } catch {
        // Nothing left to clean up for this client.
      }
    }

    if (server !== null && server.listening) {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }

    const identity = this.#ownedIdentity;
    this.#ownedIdentity = null;
    if (identity === null) return;
    this.#unlinkOwnedSocket(identity);
  }

  /** Removes the socket only while the same device/inode still names it. */
  #unlinkOwnedSocket(identity: SocketIdentity): void {
    try {
      const current = socketIdentity(this.#socketPath);
      if (
        current !== null &&
        current.device === identity.device &&
        current.inode === identity.inode
      ) {
        unlinkSync(this.#socketPath);
      }
    } catch {
      // A foreign or replaced path is never removed by this server.
    }
  }

  #onConnection(socket: Socket): void {
    if (this.#clients.size >= this.#maxConnections) {
      socket.destroy();
      return;
    }
    this.#clients.add(socket);

    let responded = false;
    let received = false;
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let requestTimer: NodeJS.Timeout | null = null;
    let lingerTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (requestTimer !== null) clearTimeout(requestTimer);
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      this.#clients.delete(socket);
    };
    const finish = (
      payload: ServerErrorResponse | ServerSuccessResponse,
    ): void => {
      if (responded) return;
      responded = true;
      if (requestTimer !== null) clearTimeout(requestTimer);
      this.#writeResponse(socket, payload);
      lingerTimer = setTimeout(() => {
        try {
          socket.destroy();
        } catch {
          // The socket is already closed.
        }
      }, RESPONSE_LINGER_MS);
      lingerTimer.unref?.();
    };

    requestTimer = setTimeout(
      () => finish({ v: 1, ok: false, error: "rejected" }),
      this.#requestTimeoutMs,
    );
    requestTimer.unref?.();

    socket.on("data", (chunk: Buffer) => {
      if (responded || received) return;
      chunks.push(chunk);
      byteLength += chunk.byteLength;
      if (byteLength > this.#maxRequestBytes) {
        received = true;
        finish({ v: 1, ok: false, error: "rejected" });
        return;
      }
      const buffer = Buffer.concat(chunks);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      received = true;
      if (newline !== buffer.length - 1) {
        finish({ v: 1, ok: false, error: "rejected" });
        return;
      }
      const line = Buffer.from(buffer.subarray(0, newline));
      void this.#handleRequest(line).then(
        (result) => finish({ v: 1, ok: true, result }),
        (error: unknown) => finish(this.#errorResponse(error)),
      );
    });
    socket.on("error", () => {
      cleanup();
      socket.destroy();
    });
    socket.on("close", cleanup);
  }

  #errorResponse(error: unknown): ServerErrorResponse {
    if (error instanceof LocalControlError) {
      return { v: 1, ok: false, error: error.code };
    }
    return { v: 1, ok: false, error: "unavailable" };
  }

  async #handleRequest(line: Buffer): Promise<unknown> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line.toString("utf8")) as unknown;
    } catch {
      throw new LocalControlError("rejected");
    }
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded)
    ) {
      throw new LocalControlError("rejected");
    }
    const body = decoded as Record<string, unknown>;
    const keys = Object.keys(body);
    if (
      keys.length !== 5 ||
      !["v", "callerId", "token", "method", "params"].every((key) =>
        Object.hasOwn(body, key),
      ) ||
      keys.some(
        (key) =>
          key !== "v" &&
          key !== "callerId" &&
          key !== "token" &&
          key !== "method" &&
          key !== "params",
      )
    ) {
      throw new LocalControlError("rejected");
    }
    if (body.v !== 1) {
      throw new LocalControlError("rejected");
    }
    const { callerId, token, method, params } = body;
    if (
      typeof callerId !== "string" ||
      !CALLER_ID_PATTERN.test(callerId) ||
      typeof token !== "string" ||
      typeof method !== "string"
    ) {
      throw new LocalControlError("rejected");
    }
    if (
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params)
    ) {
      throw new LocalControlError("rejected");
    }
    if (!this.#authenticate(callerId, token)) {
      throw new LocalControlError("rejected");
    }
    const caller = this.#authenticators.get(callerId)?.config;
    if (caller === undefined) throw new LocalControlError("rejected");
    if (!LOCAL_METHODS.includes(method as LocalMethod)) {
      throw new LocalControlError("rejected");
    }
    const localMethod = method as LocalMethod;
    if (!caller.actions.includes(localMethod)) {
      throw new LocalControlError("forbidden");
    }
    const request: LocalRequest = {
      method: localMethod,
      params: params as Readonly<Record<string, unknown>>,
    };
    return await this.#handler(caller, request);
  }

  #authenticate(callerId: string, token: string): boolean {
    if (!isValidLocalTokenLength(token)) return false;
    const provided = createHash("sha256").update(token, "utf8").digest();
    const expected = this.#authenticators.get(callerId)?.digest ?? DUMMY_DIGEST;
    const matched = timingSafeEqual(expected, provided);
    return matched && this.#authenticators.has(callerId);
  }

  #writeResponse(
    socket: Socket,
    payload: ServerErrorResponse | ServerSuccessResponse,
  ): void {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = JSON.stringify({
        v: 1,
        ok: false,
        error: "unavailable",
      } satisfies ServerErrorResponse);
    }
    let output = `${serialized}\n`;
    if (Buffer.byteLength(output, "utf8") > this.#maxResponseBytes) {
      output = `${JSON.stringify({
        v: 1,
        ok: false,
        error: "unavailable",
      } satisfies ServerErrorResponse)}\n`;
    }
    try {
      socket.end(output);
    } catch {
      socket.destroy();
    }
  }
}
