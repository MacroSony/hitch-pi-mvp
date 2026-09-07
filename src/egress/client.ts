import { lookup as dnsLookup } from "node:dns";
import {
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
} from "node:http";
import { isIP } from "node:net";

export const DEFAULT_EGRESS_LIMITS = Object.freeze({
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 256 * 1024,
  deadlineMs: 10_000,
  maxRedirects: 2,
});

export type EgressMethod = "GET" | "POST";

export interface EgressServiceConfig {
  /** Stable operator-chosen name. This is the only service selector exposed to a model. */
  readonly key: string;
  /** A complete origin, for example https://api.example.test:443. */
  readonly origin: string;
  /** Private and loopback destinations require this explicit operator decision. */
  readonly allowPrivate?: boolean;
  /** Trusted, fixed headers. No request header is accepted from the model. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A configured secret that must be removed from response text before return. */
  readonly secret?: string;
  /** Additional configured secret values to remove from response text. */
  readonly secrets?: readonly string[];
}

export interface EgressRequest {
  readonly serviceKey: string;
  /** Root-relative path and query, such as /v1/search?q=pi. */
  readonly path: string;
  readonly method: EgressMethod;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface EgressResponse {
  readonly status: number;
  readonly text: string;
}

export type EgressErrorCode =
  | "invalid-config"
  | "invalid-request"
  | "unknown-service"
  | "origin-blocked"
  | "address-blocked"
  | "dns-failed"
  | "request-too-large"
  | "response-too-large"
  | "response-encoding"
  | "redirect-blocked"
  | "deadline"
  | "aborted"
  | "transport-failed";

export class EgressError extends Error {
  readonly code: EgressErrorCode;

  constructor(code: EgressErrorCode) {
    super(`egress ${code}`);
    this.name = "EgressError";
    this.code = code;
  }
}

export interface EgressClientOptions {
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly deadlineMs?: number;
  readonly maxRedirects?: number;
  /** Test-only seam; the returned address is used as the socket lookup result. */
  readonly resolver?: AddressResolver;
}

export type AddressResolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly string[]>;

type ParsedService = EgressServiceConfig & {
  readonly originUrl: URL;
  readonly originKey: string;
  readonly fixedHeaders: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
};

interface HopResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly body: Buffer;
}

const FORBIDDEN_FIXED_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
]);

/**
 * A deliberately small, host-side client for trusted extensions. It is not a
 * fetch replacement: model input can select only a configured service and a
 * root-relative path/query.
 */
export class EgressClient {
  readonly #services: ReadonlyMap<string, ParsedService>;
  readonly #limits: Required<
    Pick<
      EgressClientOptions,
      "maxRequestBytes" | "maxResponseBytes" | "deadlineMs" | "maxRedirects"
    >
  >;
  readonly #resolver: AddressResolver;

  constructor(
    services: readonly EgressServiceConfig[],
    options: EgressClientOptions = {},
  ) {
    this.#limits = {
      maxRequestBytes:
        options.maxRequestBytes ?? DEFAULT_EGRESS_LIMITS.maxRequestBytes,
      maxResponseBytes:
        options.maxResponseBytes ?? DEFAULT_EGRESS_LIMITS.maxResponseBytes,
      deadlineMs: options.deadlineMs ?? DEFAULT_EGRESS_LIMITS.deadlineMs,
      maxRedirects: options.maxRedirects ?? DEFAULT_EGRESS_LIMITS.maxRedirects,
    };
    if (
      !Number.isSafeInteger(this.#limits.maxRequestBytes) ||
      this.#limits.maxRequestBytes <= 0 ||
      !Number.isSafeInteger(this.#limits.maxResponseBytes) ||
      this.#limits.maxResponseBytes <= 0 ||
      !Number.isSafeInteger(this.#limits.deadlineMs) ||
      this.#limits.deadlineMs <= 0 ||
      !Number.isSafeInteger(this.#limits.maxRedirects) ||
      this.#limits.maxRedirects < 0
    ) {
      throw new EgressError("invalid-config");
    }

    const parsed = new Map<string, ParsedService>();
    for (const service of services) {
      const item = parseService(service);
      if (parsed.has(item.key)) throw new EgressError("invalid-config");
      parsed.set(item.key, item);
    }
    this.#services = parsed;
    this.#resolver = options.resolver ?? defaultResolver;
  }

  async request(input: EgressRequest): Promise<EgressResponse> {
    const service = this.#services.get(input.serviceKey);
    if (!service) throw new EgressError("unknown-service");
    const method = input.method;
    if (method !== "GET" && method !== "POST") {
      throw new EgressError("invalid-request");
    }
    if (typeof input.path !== "string" || !isRelativePath(input.path)) {
      throw new EgressError("invalid-request");
    }
    if (input.body !== undefined && typeof input.body !== "string") {
      throw new EgressError("invalid-request");
    }
    if (method === "GET" && input.body !== undefined) {
      throw new EgressError("invalid-request");
    }
    const pathBytes = Buffer.byteLength(input.path, "utf8");
    const bodyBytes =
      input.body === undefined ? 0 : Buffer.byteLength(input.body, "utf8");
    if (pathBytes + bodyBytes > this.#limits.maxRequestBytes) {
      throw new EgressError("request-too-large");
    }
    const body =
      input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
    if (input.signal?.aborted) throw new EgressError("aborted");

    const first = parseRelativeUrl(
      input.path,
      service.originUrl,
      service.originKey,
    );
    const deadline = Date.now() + this.#limits.deadlineMs;
    let operationError: EgressError | undefined;
    let activeRequest: ClientRequest | undefined;
    const resolverController = new AbortController();
    const waiters = new Set<(error: EgressError) => void>();
    const failOperation = (error: EgressError): void => {
      if (operationError) return;
      operationError = error;
      resolverController.abort();
      activeRequest?.destroy();
      for (const reject of waiters) reject(error);
      waiters.clear();
    };
    const timer = setTimeout(
      () => failOperation(new EgressError("deadline")),
      this.#limits.deadlineMs,
    );
    const abort = (): void => failOperation(new EgressError("aborted"));
    input.signal?.addEventListener("abort", abort, { once: true });

    try {
      let url = first;
      let redirects = 0;
      for (;;) {
        throwIfOperationFailed(operationError);
        const address = await this.#resolvePinnedAddress(
          service,
          url,
          deadline,
          input.signal,
          resolverController.signal,
          waiters,
          () => operationError,
        );
        throwIfOperationFailed(operationError);
        const response = await this.#requestHop(
          service,
          url,
          address,
          method,
          body,
          deadline,
          (request) => {
            activeRequest = request;
          },
          () => operationError,
        );
        activeRequest = undefined;

        if (isRedirect(response.status)) {
          if (
            !response.location ||
            method === "POST" ||
            redirects >= this.#limits.maxRedirects
          ) {
            throw new EgressError("redirect-blocked");
          }
          url = parseRedirect(response.location, url, service.originKey);
          redirects += 1;
          continue;
        }

        return {
          status: response.status,
          text: sanitizeText(
            response.body,
            service.secrets,
            this.#limits.maxResponseBytes,
          ),
        };
      }
    } catch (error) {
      if (error instanceof EgressError) throw error;
      throw new EgressError("transport-failed");
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      resolverController.abort();
      activeRequest?.destroy();
    }
  }

  async #resolvePinnedAddress(
    service: ParsedService,
    url: URL,
    deadline: number,
    signal: AbortSignal | undefined,
    resolverSignal: AbortSignal,
    waiters: Set<(error: EgressError) => void>,
    operation: () => EgressError | undefined,
  ): Promise<string> {
    if (url.origin !== service.originKey)
      throw new EgressError("origin-blocked");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new EgressError("deadline");

    const literal = normalizeAddress(url.hostname);
    if (literal !== undefined) {
      const kind = addressKind(literal);
      if (
        kind === "always-blocked" ||
        (kind === "private" && !service.allowPrivate)
      ) {
        throw new EgressError("address-blocked");
      }
      return literal;
    }

    let lookup: Promise<readonly string[]>;
    try {
      lookup = Promise.resolve(this.#resolver(url.hostname, resolverSignal));
    } catch {
      throw new EgressError("dns-failed");
    }
    const addresses = await waitWithOperation(
      lookup,
      remaining,
      signal,
      waiters,
      operation,
    );
    if (addresses.length === 0) throw new EgressError("dns-failed");

    for (const candidate of addresses) {
      const address = normalizeAddress(candidate);
      if (address === undefined) continue;
      const kind = addressKind(address);
      if (
        kind === "always-blocked" ||
        (kind === "private" && !service.allowPrivate)
      ) {
        continue;
      }
      return address;
    }
    throw new EgressError("address-blocked");
  }

  #requestHop(
    service: ParsedService,
    url: URL,
    address: string,
    method: EgressMethod,
    body: Buffer | undefined,
    deadline: number,
    onRequest: (request: ClientRequest) => void,
    operation: () => EgressError | undefined,
  ): Promise<HopResponse> {
    if (url.origin !== service.originKey)
      return Promise.reject(new EgressError("origin-blocked"));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new EgressError("deadline"));
    const headers: Record<string, string | number> = {
      ...service.fixedHeaders,
    };
    headers.Host = url.host;
    headers["Accept-Encoding"] = "identity";
    headers.Connection = "close";
    if (body !== undefined) headers["Content-Length"] = body.byteLength;

    const rawHostname = url.hostname;
    const hostname =
      rawHostname.startsWith("[") && rawHostname.endsWith("]")
        ? rawHostname.slice(1, -1)
        : rawHostname;

    return new Promise<HopResponse>((resolve, reject) => {
      let response: IncomingMessage | undefined;
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const fail = (error: EgressError): void => {
        if (settled) return;
        settled = true;
        response?.destroy();
        request.destroy();
        reject(error);
      };
      const failFromOperation = (): EgressError =>
        operation() ?? new EgressError("transport-failed");
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          method,
          path: `${url.pathname}${url.search}`,
          headers,
          agent: false,
          rejectUnauthorized: url.protocol === "https:",
          lookup: (_hostname, options, callback) => {
            process.nextTick(() => {
              if (options.all)
                callback(null, [{ address, family: isIP(address) }]);
              else callback(null, address, isIP(address));
            });
          },
        },
        (incoming) => {
          response = incoming;
          const encoding = headerValue(incoming.headers, "content-encoding");
          if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
            fail(new EgressError("response-encoding"));
            return;
          }
          const contentLength = headerValue(incoming.headers, "content-length");
          if (
            contentLength !== undefined &&
            (!decimal(contentLength) ||
              Number(contentLength) > this.#limits.maxResponseBytes)
          ) {
            fail(new EgressError("response-too-large"));
            return;
          }
          incoming.on("data", (chunk: Buffer | string) => {
            const bytes =
              typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            size += bytes.byteLength;
            if (size > this.#limits.maxResponseBytes) {
              fail(new EgressError("response-too-large"));
              return;
            }
            chunks.push(bytes);
          });
          incoming.once("end", () => {
            if (settled) return;
            settled = true;
            const location = headerValue(incoming.headers, "location");
            resolve({
              status: incoming.statusCode ?? 0,
              location,
              body: Buffer.concat(chunks),
            });
          });
          incoming.once("error", () => fail(failFromOperation()));
        },
      );
      onRequest(request);
      request.once("error", () => fail(failFromOperation()));
      request.setTimeout(Math.max(1, remaining), () =>
        fail(new EgressError("deadline")),
      );
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}

function parseService(service: EgressServiceConfig): ParsedService {
  if (!service || typeof service.key !== "string" || service.key.length === 0) {
    throw new EgressError("invalid-config");
  }
  let originUrl: URL;
  try {
    originUrl = new URL(service.origin);
  } catch {
    throw new EgressError("invalid-config");
  }
  if (
    (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") ||
    originUrl.username !== "" ||
    originUrl.password !== "" ||
    originUrl.pathname !== "/" ||
    originUrl.search !== "" ||
    originUrl.hash !== "" ||
    originUrl.hostname === ""
  ) {
    throw new EgressError("invalid-config");
  }
  if (originUrl.protocol === "http:" && service.allowPrivate !== true) {
    throw new EgressError("invalid-config");
  }
  const fixedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(service.headers ?? {})) {
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      name.length === 0
    ) {
      throw new EgressError("invalid-config");
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_FIXED_HEADERS.has(lower)) {
      throw new EgressError("invalid-config");
    }
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      throw new EgressError("invalid-config");
    }
    fixedHeaders[name] = value;
  }
  const secrets = [
    ...(service.secret === undefined ? [] : [service.secret]),
    ...(service.secrets ?? []),
  ].filter((secret) => secret.length > 0);
  for (const secret of secrets) {
    if (typeof secret !== "string" || /[\r\n]/u.test(secret)) {
      throw new EgressError("invalid-config");
    }
  }
  return {
    ...service,
    originUrl,
    originKey: originUrl.origin,
    fixedHeaders,
    secrets,
  };
}

function isRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !hasControl(path)
  );
}

function parseRelativeUrl(path: string, base: URL, origin: string): URL {
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    throw new EgressError("invalid-request");
  }
  if (url.hash !== "") throw new EgressError("invalid-request");
  if (url.origin !== origin || url.username !== "" || url.password !== "") {
    throw new EgressError("origin-blocked");
  }
  return url;
}

function parseRedirect(location: string, current: URL, origin: string): URL {
  if (
    location.length === 0 ||
    location.startsWith("//") ||
    hasControl(location)
  ) {
    throw new EgressError("redirect-blocked");
  }
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new EgressError("redirect-blocked");
  }
  if (
    next.origin !== origin ||
    next.username !== "" ||
    next.password !== "" ||
    next.hash !== ""
  ) {
    throw new EgressError("redirect-blocked");
  }
  return next;
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function headerValue(
  headers: IncomingHttpHeaders,
  wanted: string,
): string | undefined {
  const value = headers[wanted];
  if (Array.isArray(value)) return value[0];
  return value;
}

function decimal(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value)
    if (character < "0" || character > "9") return false;
  return Number.isSafeInteger(Number(value));
}

function sanitizeText(
  body: Buffer,
  secrets: readonly string[],
  maxBytes: number,
): string {
  let text = "";
  for (const character of body.toString("utf8")) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code === 9 ||
      code === 10 ||
      (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))
    ) {
      text += character;
    }
  }
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return truncateUtf8(text, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  return buffer
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f))
      return true;
  }
  return false;
}

async function defaultResolver(hostname: string): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(addresses.map((entry) => entry.address));
    });
  });
}

function waitWithOperation<T>(
  operationPromise: Promise<T>,
  remaining: number,
  signal: AbortSignal | undefined,
  waiters: Set<(error: EgressError) => void>,
  operation: () => EgressError | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      waiters.delete(onOperation);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOperation = (error: EgressError): void => {
      done();
      reject(error);
    };
    const onAbort = (): void => {
      done();
      reject(new EgressError("aborted"));
    };
    timer = setTimeout(() => {
      done();
      reject(new EgressError("deadline"));
    }, remaining);
    waiters.add(onOperation);
    signal?.addEventListener("abort", onAbort, { once: true });
    operationPromise.then(
      (value) => {
        done();
        const error = operation();
        if (error) reject(error);
        else resolve(value);
      },
      () => {
        done();
        const error = operation();
        reject(error ?? new EgressError("dns-failed"));
      },
    );
  });
}

function throwIfOperationFailed(error: EgressError | undefined): void {
  if (error) throw error;
}

type AddressKind = "public" | "private" | "always-blocked";

function normalizeAddress(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("%"))
    return undefined;
  const address =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return isIP(address) === 0 ? undefined : address;
}

function addressKind(address: string): AddressKind {
  if (isIP(address) === 4) return ipv4Kind(address);
  const words = parseIpv6(address);
  if (!words) return "always-blocked";
  if (words.every((word) => word === 0)) return "always-blocked";
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) {
    return "private";
  }
  const mapped =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mapped) return "always-blocked";
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0);
  if (ipv4Compatible) return "always-blocked";
  const first = words[0] ?? 0;
  if (first >= 0xff00) return "always-blocked";
  if (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0
  ) {
    return "private";
  }
  if (first === 0x2001 && (words[1] ?? 0) === 0x0db8) return "private";
  return "public";
}

function ipv4Kind(address: string): AddressKind {
  const octets = address.split(".").map(Number);
  const value =
    (((octets[0] ?? 0) * 256 + (octets[1] ?? 0)) * 256 + (octets[2] ?? 0)) *
      256 +
    (octets[3] ?? 0);
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  if (
    value === 0 ||
    first === 0 ||
    first >= 224 ||
    value === 0xffffffff ||
    value === 0xa9fea9fe
  ) {
    return "always-blocked";
  }
  if (
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 &&
      second === 0 &&
      ((octets[2] ?? 0) === 0 || (octets[2] ?? 0) === 2)) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 198 && second === 51 && (octets[2] ?? 0) === 100) ||
    (first === 203 && second === 0 && (octets[2] ?? 0) === 113) ||
    first >= 240
  ) {
    return "private";
  }
  return "public";
}

function parseIpv6(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (half === "") return [];
    const parts = half.split(":");
    const words: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) return undefined;
      if (part.includes(".")) {
        if (index !== parts.length - 1) return undefined;
        const kind = ipv4Parts(part);
        if (!kind) return undefined;
        words.push(kind[0], kind[1]);
      } else {
        if (!/^[0-9a-f]{1,4}$/iu.test(part)) return undefined;
        words.push(Number.parseInt(part, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = halves.length === 2 ? parseHalf(halves[1] ?? "") : [];
  if (
    !left ||
    !right ||
    (halves.length === 1 && left.length !== 8) ||
    (halves.length === 2 && left.length + right.length >= 8)
  )
    return undefined;
  return [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => 0),
    ...right,
  ];
}

function ipv4Parts(value: string): [number, number] | undefined {
  const parts = value.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return undefined;
  return [
    (parts[0] ?? 0) * 256 + (parts[1] ?? 0),
    (parts[2] ?? 0) * 256 + (parts[3] ?? 0),
  ];
}
