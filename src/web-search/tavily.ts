import { EgressClient, EgressError } from "../egress/client.js";

const MAX_QUERY_BYTES = 512;
const MAX_TOTAL_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 5;

export interface TavilySearchAdapterOptions {
  readonly apiKey: string;
  readonly origin?: string;
  readonly allowPrivate?: boolean;
}

export interface TavilySearchInput {
  readonly query: string;
  readonly limit?: number;
}

export interface TavilySearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface TavilySearchResult {
  readonly items: readonly TavilySearchResultItem[];
}

export class TavilySearchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`tavily search: ${code}`);
    this.name = "TavilySearchError";
    this.code = code;
  }
}

export class TavilySearchAdapter {
  readonly #client: EgressClient;
  readonly #redactionSecrets: readonly string[];

  constructor(options: TavilySearchAdapterOptions) {
    if (
      !options ||
      typeof options.apiKey !== "string" ||
      options.apiKey.length === 0 ||
      /[\r\n]/u.test(options.apiKey)
    ) {
      throw new TavilySearchError("invalid-config");
    }
    const origin = options.origin ?? "https://api.tavily.com";
    const apiKey = options.apiKey;
    const bearer = `Bearer ${apiKey}`;
    this.#redactionSecrets = Object.freeze(
      Array.from(new Set([bearer, apiKey])).sort((a, b) => b.length - a.length),
    );
    this.#client = new EgressClient([
      {
        key: "tavily",
        origin,
        allowPrivate: options.allowPrivate === true,
        headers: {
          Authorization: bearer,
          "Content-Type": "application/json",
        },
        secret: apiKey,
        secrets: [bearer],
      },
    ]);
  }

  async search(
    input: TavilySearchInput,
    signal?: AbortSignal,
  ): Promise<TavilySearchResult> {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TavilySearchError("invalid-input");
    }
    for (const key of Object.keys(input)) {
      if (key !== "query" && key !== "limit") {
        throw new TavilySearchError("invalid-input");
      }
    }
    if (
      !Object.hasOwn(input, "query") ||
      typeof input.query !== "string" ||
      input.query.trim().length === 0
    ) {
      throw new TavilySearchError("invalid-input");
    }
    const queryBytes = Buffer.byteLength(input.query, "utf8");
    if (queryBytes > MAX_QUERY_BYTES) {
      throw new TavilySearchError("invalid-input");
    }

    let limit = DEFAULT_LIMIT;
    if (input.limit !== undefined) {
      if (
        typeof input.limit !== "number" ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < MIN_LIMIT ||
        input.limit > MAX_LIMIT
      ) {
        throw new TavilySearchError("invalid-input");
      }
      limit = input.limit;
    }

    const body = JSON.stringify({
      query: input.query,
      max_results: limit,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    });

    let egressResponse;
    try {
      egressResponse = await this.#client.request({
        serviceKey: "tavily",
        method: "POST",
        path: "/search",
        body,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof EgressError) {
        throw new TavilySearchError(`egress-${error.code}`);
      }
      throw new TavilySearchError("transport-failed");
    }

    if (egressResponse.status < 200 || egressResponse.status >= 300) {
      throw new TavilySearchError(`http-${egressResponse.status}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(egressResponse.text);
    } catch {
      throw new TavilySearchError("invalid-response-json");
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new TavilySearchError("invalid-response-shape");
    }

    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.results)) {
      throw new TavilySearchError("invalid-response-shape");
    }

    const items: TavilySearchResultItem[] = [];

    for (const candidate of record.results) {
      if (items.length >= limit) break;
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        continue;
      }
      const entry = candidate as Record<string, unknown>;
      if (
        typeof entry.title !== "string" ||
        typeof entry.url !== "string" ||
        typeof entry.content !== "string"
      ) {
        continue;
      }
      if (hasControl(entry.url)) {
        continue;
      }
      if (this.#containsSecret(entry.url)) {
        continue;
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(entry.url);
      } catch {
        continue;
      }
      if (
        (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
        parsedUrl.username !== "" ||
        parsedUrl.password !== "" ||
        parsedUrl.hostname === ""
      ) {
        continue;
      }
      const url = parsedUrl.href;
      if (
        url.length > 2048 ||
        Buffer.byteLength(url, "utf8") > 2048 ||
        this.#containsSecret(url)
      ) {
        continue;
      }

      const title = truncateString(this.#redact(cleanText(entry.title)), 512);
      const snippet = truncateString(
        this.#redact(cleanText(entry.content)),
        4096,
      );

      const fullCandidate: TavilySearchResultItem = { title, url, snippet };
      if (
        Buffer.byteLength(
          JSON.stringify({ items: [...items, fullCandidate] }),
          "utf8",
        ) <= MAX_TOTAL_RESPONSE_BYTES
      ) {
        items.push(fullCandidate);
        continue;
      }

      const emptyCandidate: TavilySearchResultItem = {
        title,
        url,
        snippet: "",
      };
      if (
        Buffer.byteLength(
          JSON.stringify({ items: [...items, emptyCandidate] }),
          "utf8",
        ) > MAX_TOTAL_RESPONSE_BYTES
      ) {
        break;
      }

      let low = 0;
      let high = snippet.length;
      let bestLength = 0;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const testSnippet = truncateString(snippet, mid);
        const testCandidate: TavilySearchResultItem = {
          title,
          url,
          snippet: testSnippet,
        };
        if (
          Buffer.byteLength(
            JSON.stringify({ items: [...items, testCandidate] }),
            "utf8",
          ) <= MAX_TOTAL_RESPONSE_BYTES
        ) {
          bestLength = testSnippet.length;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      const truncatedSnippet = truncateString(snippet, bestLength);
      items.push({ title, url, snippet: truncatedSnippet });
      break;
    }

    return { items };
  }

  #containsSecret(value: string): boolean {
    return (
      value.includes("[REDACTED]") ||
      this.#redactionSecrets.some((secret) => value.includes(secret))
    );
  }

  #redact(value: string): string {
    let result = value;
    for (const secret of this.#redactionSecrets) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
    return result;
  }
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function cleanText(value: string): string {
  let text = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))
    ) {
      text += character;
    }
  }
  return text;
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let truncated = value.slice(0, maxLength);
  if (
    truncated.length > 0 &&
    truncated.charCodeAt(truncated.length - 1) >= 0xd800 &&
    truncated.charCodeAt(truncated.length - 1) <= 0xdbff
  ) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}
