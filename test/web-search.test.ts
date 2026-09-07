import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import test from "node:test";

import {
  TavilySearchAdapter,
  TavilySearchError,
} from "../src/web-search/tavily.js";

interface Fixture {
  readonly server: Server;
  readonly origin: string;
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Fixture> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("tavily adapter executes real egress with fixed headers, method, path, and body", async (t) => {
  let receivedMethod = "";
  let receivedPath = "";
  let receivedAuth = "";
  let receivedContentType = "";
  let receivedBody = "";

  const fixture = await listen((request, response) => {
    receivedMethod = request.method ?? "";
    receivedPath = request.url ?? "";
    receivedAuth = request.headers.authorization ?? "";
    receivedContentType = request.headers["content-type"] ?? "";
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      receivedBody = body;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "TypeScript Documentation",
              url: "https://www.typescriptlang.org/docs/",
              content: "TypeScript is JavaScript with syntax for types.",
            },
            {
              title: "Node.js",
              url: "https://nodejs.org/en",
              content: "Node.js JavaScript runtime.",
            },
          ],
        }),
      );
    });
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "tvly-secret-key-12345",
    origin: fixture.origin,
    allowPrivate: true,
  });

  const result = await adapter.search({ query: "typescript node" });
  assert.equal(receivedMethod, "POST");
  assert.equal(receivedPath, "/search");
  assert.equal(receivedAuth, "Bearer tvly-secret-key-12345");
  assert.equal(receivedContentType, "application/json");

  const parsedBody = JSON.parse(receivedBody) as Record<string, unknown>;
  assert.equal(parsedBody.query, "typescript node");
  assert.equal(parsedBody.max_results, 5);
  assert.equal(parsedBody.search_depth, "basic");
  assert.equal(parsedBody.include_answer, false);
  assert.equal(parsedBody.include_raw_content, false);

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    title: "TypeScript Documentation",
    url: "https://www.typescriptlang.org/docs/",
    snippet: "TypeScript is JavaScript with syntax for types.",
  });
  assert.deepEqual(result.items[1], {
    title: "Node.js",
    url: "https://nodejs.org/en",
    snippet: "Node.js JavaScript runtime.",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 16 * 1024);
});

test("tavily adapter bounds custom limit and caps items", async (t) => {
  let receivedBody = "";
  const fixture = await listen((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      receivedBody = body;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            { title: "T1", url: "https://example.com/1", content: "C1" },
            { title: "T2", url: "https://example.com/2", content: "C2" },
            { title: "T3", url: "https://example.com/3", content: "C3" },
          ],
        }),
      );
    });
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "test-key",
    origin: fixture.origin,
    allowPrivate: true,
  });

  const result = await adapter.search({ query: "test", limit: 2 });
  const parsedBody = JSON.parse(receivedBody) as Record<string, unknown>;
  assert.equal(parsedBody.max_results, 2);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.title, "T1");
  assert.equal(result.items[1]?.title, "T2");
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 16 * 1024);
});

test("tavily adapter sanitizes URLs, strips control chars, and skips invalid items", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        results: [
          // 1. Invalid URL scheme (javascript:) - skip
          {
            title: "Bad Scheme",
            url: "javascript:alert(1)",
            content: "payload",
          },
          // 2. URL with userinfo - skip
          {
            title: "User Info",
            url: "https://user:pass@example.com/secret",
            content: "payload",
          },
          // 3. URL with control characters - skip
          {
            title: "Control in URL",
            url: "https://example.com/bad\u0000path",
            content: "payload",
          },
          // 4. Missing required field (content missing) - skip
          {
            title: "No Content",
            url: "https://example.com/good",
          },
          // 5. Valid item with control chars in title and content - sanitized
          {
            title: "Good\u0000 Title\t\n",
            url: "https://example.com/valid",
            content: "Good\u0007 snippet text\nline 2",
          },
        ],
      }),
    );
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "test-key",
    origin: fixture.origin,
    allowPrivate: true,
  });

  const result = await adapter.search({ query: "sanitization" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.title, "Good Title\t\n");
  assert.equal(result.items[0]?.url, "https://example.com/valid");
  assert.equal(result.items[0]?.snippet, "Good snippet text\nline 2");
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 16 * 1024);
});

test("tavily adapter bounds snippet and overall response size to ~16KiB", async (t) => {
  const hugeSnippet = "a".repeat(10_000);
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        results: [
          {
            title: "Item 1",
            url: "https://example.com/1",
            content: hugeSnippet,
          },
          {
            title: "Item 2",
            url: "https://example.com/2",
            content: hugeSnippet,
          },
          {
            title: "Item 3",
            url: "https://example.com/3",
            content: hugeSnippet,
          },
        ],
      }),
    );
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "test-key",
    origin: fixture.origin,
    allowPrivate: true,
  });

  const result = await adapter.search({ query: "large content" });
  assert.ok(result.items.length >= 1);
  assert.ok(result.items.length <= 5);
  for (const item of result.items) {
    assert.ok(item.title.length <= 512);
    assert.ok(item.url.length <= 2048);
    assert.ok(item.snippet.length <= 4096);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 16 * 1024);
});

test("tavily adapter bounds responses with extensive quotes, backslashes, and newlines", async (t) => {
  // Repeating quotes, backslashes, and newlines expand significantly when JSON-serialized
  const heavyEscapingSnippet = '\\"\n\r\t"\\\\'.repeat(1200);
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        results: [
          {
            title: 'Quote "Title" \\ Backslash \n Test',
            url: "https://example.com/escapes-1",
            content: heavyEscapingSnippet,
          },
          {
            title: 'Quote "Title 2" \\ Backslash \n Test',
            url: "https://example.com/escapes-2",
            content: heavyEscapingSnippet,
          },
          {
            title: 'Quote "Title 3" \\ Backslash \n Test',
            url: "https://example.com/escapes-3",
            content: heavyEscapingSnippet,
          },
          {
            title: 'Quote "Title 4" \\ Backslash \n Test',
            url: "https://example.com/escapes-4",
            content: heavyEscapingSnippet,
          },
        ],
      }),
    );
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "test-key",
    origin: fixture.origin,
    allowPrivate: true,
  });

  const result = await adapter.search({ query: "escaping test" });
  assert.ok(result.items.length >= 1);
  assert.ok(result.items.length <= 5);
  for (const item of result.items) {
    assert.ok(item.title.length <= 512);
    assert.ok(item.url.length <= 2048);
    assert.ok(item.snippet.length <= 4096);
    assert.ok(item.url.startsWith("https://example.com/"));
  }
  // Actual serialization budget including wrapping and JSON escaping must be <= 16KiB
  const serializedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(serializedBytes <= 16 * 1024);
});

test("tavily adapter handles multi-byte UTF-8 characters and emojis without truncation corruption", async (t) => {
  const multiByteSnippet =
    "TypeScript 是一种基于 JavaScript 的强类型编程语言。🚀🔥🎉💻\n" +
    "日本語テキストと絵文字のテストです。🌏✨".repeat(200);

  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        results: [
          {
            title: "多字节标题 🌟 TypeScript 文档",
            url: "https://example.com/multibyte-1",
            content: multiByteSnippet,
          },
          {
            title: "多字节标题 2 🚀 Node.js",
            url: "https://example.com/multibyte-2",
            content: multiByteSnippet,
          },
        ],
      }),
    );
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "test-key",
    origin: fixture.origin,
    allowPrivate: true,
  });

  const result = await adapter.search({ query: "multibyte test" });
  assert.ok(result.items.length >= 1);
  for (const item of result.items) {
    assert.ok(item.title.length <= 512);
    assert.ok(item.url.length <= 2048);
    assert.ok(item.snippet.length <= 4096);
    // Ensure no broken trailing surrogate
    if (item.snippet.length > 0) {
      const lastCharCode = item.snippet.charCodeAt(item.snippet.length - 1);
      assert.ok(
        lastCharCode < 0xd800 || lastCharCode > 0xdbff,
        "snippet must not end with an unpaired high surrogate",
      );
    }
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(serializedBytes <= 16 * 1024);
  // Verify valid JSON round-trip
  const roundTrip = JSON.parse(JSON.stringify(result)) as typeof result;
  assert.equal(roundTrip.items.length, result.items.length);
});

test("tavily adapter handles long results exceeding limits with non-empty valid sources", async (t) => {
  const longSnippet = "Knowledge snippet for search test. ".repeat(300);
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        results: Array.from({ length: 10 }, (_, index) => ({
          title: `Result Source ${index + 1}`,
          url: `https://example.com/source/${index + 1}`,
          content: `${longSnippet} - Source ${index + 1}`,
        })),
      }),
    );
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "test-key",
    origin: fixture.origin,
    allowPrivate: true,
  });

  const result = await adapter.search({ query: "long results" });
  assert.ok(result.items.length >= 1);
  assert.ok(result.items.length <= 5);
  for (const item of result.items) {
    assert.ok(item.title.length > 0 && item.title.length <= 512);
    assert.ok(item.url.startsWith("https://example.com/source/"));
    assert.ok(item.url.length <= 2048);
    assert.ok(item.snippet.length <= 4096);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 16 * 1024);
});

test("tavily adapter rejects malformed schema, invalid JSON, and non-2xx status", async (t) => {
  let statusCode = 500;
  let responsePayload = "";
  const fixture = await listen((_request, response) => {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(responsePayload);
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "super-secret-api-key",
    origin: fixture.origin,
    allowPrivate: true,
  });

  // 1. Non-2xx status code
  statusCode = 401;
  responsePayload = JSON.stringify({
    error: "Unauthorized super-secret-api-key",
  });
  await assert.rejects(
    () => adapter.search({ query: "test" }),
    (error: unknown) => {
      assert.ok(error instanceof TavilySearchError);
      assert.equal(error.code, "http-401");
      assert.ok(!error.message.includes("super-secret-api-key"));
      return true;
    },
  );

  // 2. Invalid JSON in 200 response
  statusCode = 200;
  responsePayload = "not valid json {";
  await assert.rejects(
    () => adapter.search({ query: "test" }),
    (error: unknown) => {
      assert.ok(error instanceof TavilySearchError);
      assert.equal(error.code, "invalid-response-json");
      return true;
    },
  );

  // 3. Non-array results
  statusCode = 200;
  responsePayload = JSON.stringify({ results: "not-an-array" });
  await assert.rejects(
    () => adapter.search({ query: "test" }),
    (error: unknown) => {
      assert.ok(error instanceof TavilySearchError);
      assert.equal(error.code, "invalid-response-shape");
      return true;
    },
  );

  // 4. Non-object root
  statusCode = 200;
  responsePayload = JSON.stringify(["an", "array"]);
  await assert.rejects(
    () => adapter.search({ query: "test" }),
    (error: unknown) => {
      assert.ok(error instanceof TavilySearchError);
      assert.equal(error.code, "invalid-response-shape");
      return true;
    },
  );
});

test("tavily adapter redacts configured secret from response content and JSON \\u escapes", async (t) => {
  const secretKey = "my-secret-token-xyz";
  // JSON unicode-escaped representation of the secret
  const unicodeEscapedSecret =
    "\\u006d\\u0079\\u002d\\u0073\\u0065\\u0063\\u0072\\u0065\\u0074\\u002d\\u0074\\u006f\\u006b\\u0065\\u006e\\u002d\\u0078\\u0079\\u007a";

  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    // Raw JSON string payload containing plain secrets and JSON \u escapes
    const rawPayload =
      `{"results":[` +
      `{"title":"Title with plain ${secretKey} and escaped ${unicodeEscapedSecret}","url":"https://example.com/safe-1","content":"Content has Bearer ${secretKey} and escaped ${unicodeEscapedSecret}"},` +
      `{"title":"Leaky URL result","url":"https://example.com/leak?token=${secretKey}","content":"Some content"},` +
      `{"title":"Leaky URL result with escape","url":"https://example.com/leak?token=${unicodeEscapedSecret}","content":"Some content"},` +
      `{"title":"Clean Source","url":"https://example.com/clean","content":"Completely safe content"}` +
      `]}\n`;
    response.end(rawPayload);
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: secretKey,
    origin: fixture.origin,
    allowPrivate: true,
  });

  const result = await adapter.search({ query: "leak test" });
  assert.equal(result.items.length, 2);

  // Item 1: redacted from both plain and \u escaped occurrences
  assert.equal(result.items[0]?.url, "https://example.com/safe-1");
  assert.ok(!result.items[0]?.title.includes(secretKey));
  assert.ok(!result.items[0]?.snippet.includes(secretKey));
  assert.ok(result.items[0]?.title.includes("[REDACTED]"));
  assert.ok(result.items[0]?.snippet.includes("[REDACTED]"));

  // Item 2: clean source preserved, both leaky URLs were dropped
  assert.equal(result.items[1]?.title, "Clean Source");
  assert.equal(result.items[1]?.url, "https://example.com/clean");
  assert.equal(result.items[1]?.snippet, "Completely safe content");

  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 16 * 1024);
});

test("tavily adapter strictly validates search input", async () => {
  const adapter = new TavilySearchAdapter({
    apiKey: "test-key",
    origin: "https://api.tavily.com",
  });

  // Empty query
  await assert.rejects(
    () => adapter.search({ query: "" }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-input",
  );
  await assert.rejects(
    () => adapter.search({ query: "   " }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-input",
  );

  // Query > 512 UTF-8 bytes
  const largeQuery = "x".repeat(513);
  await assert.rejects(
    () => adapter.search({ query: largeQuery }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-input",
  );

  // Invalid limit
  await assert.rejects(
    () => adapter.search({ query: "ok", limit: 0 }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-input",
  );
  await assert.rejects(
    () => adapter.search({ query: "ok", limit: 6 }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-input",
  );
  await assert.rejects(
    () => adapter.search({ query: "ok", limit: 2.5 }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-input",
  );

  // Unknown fields rejected
  await assert.rejects(
    () =>
      adapter.search({
        query: "ok",
        unknownField: "value",
      } as unknown as { query: string }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-input",
  );

  // Non-object input
  await assert.rejects(
    () => adapter.search(null as unknown as { query: string }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-input",
  );
});

test("tavily adapter validates constructor options", () => {
  assert.throws(
    () => new TavilySearchAdapter({ apiKey: "" }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-config",
  );
  assert.throws(
    () => new TavilySearchAdapter({ apiKey: "key\nwith\nnewline" }),
    (error: unknown) =>
      error instanceof TavilySearchError && error.code === "invalid-config",
  );
});

test("tavily adapter handles abort signal cleanly", async (t) => {
  const fixture = await listen((_request, _response) => {
    // Deliberately hold the connection open
  });
  t.after(() => close(fixture.server));

  const adapter = new TavilySearchAdapter({
    apiKey: "test-key",
    origin: fixture.origin,
    allowPrivate: true,
  });

  const controller = new AbortController();
  const searchPromise = adapter.search(
    { query: "abort test" },
    controller.signal,
  );
  controller.abort();

  await assert.rejects(
    searchPromise,
    (error: unknown) =>
      error instanceof TavilySearchError &&
      (error.code === "egress-aborted" || error.code === "transport-failed"),
  );
});
