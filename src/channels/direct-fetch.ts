import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";

const MAX_REDIRECTS = 5;

interface DirectResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
  };
  readonly body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function responseFor(
  status: number,
  headers: IncomingHttpHeaders,
  stream: Readable,
): DirectResponse {
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const value = headers[name.toLowerCase()];
        return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
      },
    },
    body,
    async text(): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    async json(): Promise<unknown> {
      return JSON.parse(await this.text()) as unknown;
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).buffer as ArrayBuffer;
    },
  };
}

function directRequest(
  url: URL,
  init: RequestInit,
  redirects: number,
): Promise<DirectResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (typeof value === "string") headers[name] = value;
    }
    const body =
      typeof init.body === "string"
        ? Buffer.from(init.body, "utf8")
        : init.body instanceof Uint8Array
          ? Buffer.from(init.body)
          : null;
    if (body !== null && headers["content-length"] === undefined)
      headers["content-length"] = String(body.length);
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers,
      },
      (res) => {
        if (
          res.statusCode !== undefined &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location !== undefined &&
          redirects < MAX_REDIRECTS
        ) {
          res.resume();
          resolve(
            directRequest(
              new URL(res.headers.location, url),
              init,
              redirects + 1,
            ),
          );
          return;
        }
        resolve(responseFor(res.statusCode ?? 502, res.headers, res));
      },
    );
    req.once("error", reject);
    const signal = init.signal ?? undefined;
    if (signal !== undefined) {
      const onAbort = (): void => {
        const abort = new Error("aborted");
        abort.name = "AbortError";
        req.destroy(abort);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * Minimal direct HTTPS fetch used for WeChat API and CDN traffic. The WeChat
 * API returns a content-length value that undici 8 rejects, and proxying its
 * CDN downloads has produced truncated responses during dogfood, so this
 * implementation intentionally stays direct and accepts the platform headers
 * verbatim.
 */
export function directFetcher(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const url = new URL(String(input));
  return directRequest(url, init ?? {}, 0) as unknown as Promise<Response>;
}
