import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

import { LOCAL_METHODS, type LocalRequest } from "./types.js";

/** Default exchange deadline for {@link callLocal}. */
export const LOCAL_CLIENT_TIMEOUT_MS = 5_000;
/** Default request-body bound for {@link callLocal}. */
export const LOCAL_CLIENT_REQUEST_BYTES = 64 * 1024;
/** Default response-body bound for {@link callLocal}. */
export const LOCAL_CLIENT_RESPONSE_BYTES = 1024 * 1024;
const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 4 * 1024;
const CALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Stable, non-leaking error categories for every local control call. */
export type LocalClientErrorCode =
  | "rejected"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "busy"
  | "unavailable"
  | "connection"
  | "timeout"
  | "too-large"
  | "protocol";

const SERVER_ERROR_CODES: ReadonlySet<string> = new Set([
  "rejected",
  "forbidden",
  "not-found",
  "conflict",
  "busy",
  "unavailable",
]);

export class LocalClientError extends Error {
  public constructor(
    public readonly code: LocalClientErrorCode,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? code, options);
    this.name = "LocalClientError";
  }
}

export interface CallLocalOptions {
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

interface DecodedResponse {
  readonly error?: LocalClientError;
  readonly value?: unknown;
}

function isServerErrorCode(value: string): value is LocalClientErrorCode {
  return SERVER_ERROR_CODES.has(value);
}

function decodeResponse(decoded: unknown): DecodedResponse {
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    return {
      error: new LocalClientError(
        "protocol",
        "local control returned an invalid response",
      ),
    };
  }
  const record = decoded as Record<string, unknown>;
  if (record.v !== 1) {
    return {
      error: new LocalClientError(
        "protocol",
        "local control returned an invalid response",
      ),
    };
  }
  if (record.ok === true) {
    return { value: record.result };
  }
  if (
    record.ok === false &&
    typeof record.error === "string" &&
    isServerErrorCode(record.error)
  ) {
    return { error: new LocalClientError(record.error, record.error) };
  }
  return {
    error: new LocalClientError(
      "protocol",
      "local control returned an invalid response",
    ),
  };
}

/**
 * Sends exactly one JSONL request to the owner-private control socket and
 * resolves with the handler result. All failures use stable error codes and
 * never include the token, request body, or server paths.
 */
export async function callLocal(
  socketPath: string,
  callerId: string,
  token: string,
  request: LocalRequest,
  options: CallLocalOptions = {},
): Promise<unknown> {
  if (typeof socketPath !== "string" || !isAbsolute(socketPath)) {
    throw new LocalClientError(
      "protocol",
      "local control socket path must be absolute",
    );
  }
  if (typeof callerId !== "string" || !CALLER_ID_PATTERN.test(callerId)) {
    throw new LocalClientError("protocol", "invalid local control caller id");
  }
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") < MIN_TOKEN_BYTES ||
    Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES
  ) {
    throw new LocalClientError("protocol", "invalid local control token");
  }
  if (!LOCAL_METHODS.includes(request.method)) {
    throw new LocalClientError("protocol", "invalid local control method");
  }
  const params: unknown = request.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new LocalClientError("protocol", "invalid local control parameters");
  }
  const timeoutMs = options.timeoutMs ?? LOCAL_CLIENT_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? LOCAL_CLIENT_REQUEST_BYTES;
  const maxResponseBytes =
    options.maxResponseBytes ?? LOCAL_CLIENT_RESPONSE_BYTES;
  for (const [label, value] of [
    ["timeoutMs", timeoutMs],
    ["maxRequestBytes", maxRequestBytes],
    ["maxResponseBytes", maxResponseBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new LocalClientError(
        "protocol",
        `local control ${label} must be a positive integer`,
      );
    }
  }

  let body: Buffer;
  try {
    body = Buffer.from(
      `${JSON.stringify({
        v: 1,
        callerId,
        token,
        method: request.method,
        params,
      })}\n`,
      "utf8",
    );
  } catch (error) {
    throw new LocalClientError(
      "protocol",
      "local control request is not serializable",
      { cause: error },
    );
  }
  if (body.byteLength > maxRequestBytes) {
    throw new LocalClientError(
      "too-large",
      "local control request exceeds the size limit",
    );
  }

  return await new Promise<unknown>((resolveCall, rejectCall) => {
    let settled = false;
    let responseBytes = 0;
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;
    const socket = createConnection({ path: socketPath });

    const finish = (error?: LocalClientError, value?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error !== undefined) rejectCall(error);
      else resolveCall(value);
    };

    timer = setTimeout(
      () =>
        finish(
          new LocalClientError("timeout", "local control request timed out"),
        ),
      timeoutMs,
    );
    timer.unref?.();

    socket.on("error", (error: Error) => {
      finish(
        new LocalClientError("connection", "local control connection failed", {
          cause: error,
        }),
      );
    });
    socket.on("close", () => {
      finish(
        new LocalClientError(
          "connection",
          "local control connection closed before a response",
        ),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      responseBytes += chunk.byteLength;
      if (responseBytes > maxResponseBytes) {
        finish(
          new LocalClientError(
            "too-large",
            "local control response exceeds the size limit",
          ),
        );
        return;
      }
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== buffer.length - 1) {
        finish(
          new LocalClientError(
            "protocol",
            "local control returned an invalid response",
          ),
        );
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          buffer.subarray(0, newline).toString("utf8"),
        ) as unknown;
      } catch (error) {
        finish(
          new LocalClientError(
            "protocol",
            "local control returned an invalid response",
            { cause: error },
          ),
        );
        return;
      }
      const response = decodeResponse(decoded);
      finish(response.error, response.value);
    });
    socket.on("connect", () => {
      socket.write(body);
    });
  });
}
