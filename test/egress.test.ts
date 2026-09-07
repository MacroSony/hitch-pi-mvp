import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import test from "node:test";

import { EgressClient, EgressError } from "../src/egress/client.js";

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
  return { server, origin: `http://egress.test:${address.port}` };
}

async function listenIpv6(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Fixture | undefined> {
  const server = createServer(handler);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "EADDRNOTAVAIL" ||
      code === "EAFNOSUPPORT" ||
      code === "EPERM" ||
      code === "ENOPROTOOPT"
    ) {
      return undefined;
    }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, origin: `http://[::1]:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function localClient(
  origin: string,
  resolver: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly string[]>,
  options: ConstructorParameters<typeof EgressClient>[1] = {},
): EgressClient {
  return new EgressClient(
    [
      {
        key: "local",
        origin,
        allowPrivate: true,
        headers: {
          Authorization: "Bearer operator-secret",
          "X-Trusted": "yes",
        },
        secret: "operator-secret",
      },
    ],
    { resolver, ...options },
  );
}

function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(
    action,
    (error: unknown) => error instanceof EgressError && error.code === code,
  );
}

test("uses the real Node HTTP transport for bounded GET and POST", async (t) => {
  let receivedMethod = "";
  let receivedPath = "";
  let receivedAuthorization = "";
  let receivedBody = "";
  const fixture = await listen((request, response) => {
    receivedMethod = request.method ?? "";
    receivedPath = request.url ?? "";
    receivedAuthorization = request.headers.authorization ?? "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = Buffer.concat(chunks).toString("utf8");
      const payload = Buffer.concat([
        Buffer.from("line\tkept\nsecret=operator-secret\u0000bad ", "utf8"),
        Buffer.from([0xff]),
      ]);
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(payload);
    });
  });
  t.after(() => close(fixture.server));
  const resolverCalls: string[] = [];
  const client = localClient(fixture.origin, async (hostname) => {
    resolverCalls.push(hostname);
    return ["127.0.0.1"];
  });

  const get = await client.request({
    serviceKey: "local",
    method: "GET",
    path: "/search?q=pi",
  });
  assert.equal(get.status, 200);
  assert.match(get.text, /line\tkept\n/u);
  assert.match(get.text, /�/u);
  assert.doesNotMatch(get.text, /operator-secret/u);

  const post = await client.request({
    serviceKey: "local",
    method: "POST",
    path: "/submit",
    body: "hello",
  });
  assert.equal(post.status, 200);
  assert.equal(receivedMethod, "POST");
  assert.equal(receivedPath, "/submit");
  assert.equal(receivedAuthorization, "Bearer operator-secret");
  assert.equal(receivedBody, "hello");
  assert.ok(resolverCalls.length >= 2);
});

test("requires an explicit private HTTP configuration and rejects unsafe model URLs", async () => {
  assert.throws(
    () => new EgressClient([{ key: "x", origin: "http://example.test:80" }]),
    (error: unknown) => {
      return error instanceof EgressError && error.code === "invalid-config";
    },
  );
  assert.doesNotThrow(
    () => new EgressClient([{ key: "x", origin: "https://example.test:443" }]),
  );

  const client = new EgressClient(
    [{ key: "x", origin: "https://example.test:443" }],
    { resolver: async () => ["203.0.113.1"] },
  );
  await expectCode(
    client.request({ serviceKey: "x", method: "GET", path: "//other.test/x" }),
    "invalid-request",
  );
  await expectCode(
    client.request({
      serviceKey: "x",
      method: "GET",
      path: "https://other.test/x",
    }),
    "invalid-request",
  );
  await expectCode(
    client.request({ serviceKey: "x", method: "GET", path: "/x#fragment" }),
    "invalid-request",
  );
});

test("rechecks exact origin on redirects and never replays POST", async (t) => {
  let followed = false;
  const first = await listen((request, response) => {
    if (request.url === "/same") {
      response.writeHead(302, { Location: "/ok" });
      response.end();
    } else if (request.url === "/cross") {
      response.writeHead(302, { Location: "http://other.test:1234/no" });
      response.end();
    } else if (request.url === "/post") {
      response.writeHead(307, { Location: "/ok" });
      response.end();
    } else {
      followed = true;
      response.end("ok");
    }
  });
  t.after(() => close(first.server));
  const resolver = async (): Promise<readonly string[]> => ["127.0.0.1"];
  const client = localClient(first.origin, resolver, { maxRedirects: 1 });

  const same = await client.request({
    serviceKey: "local",
    method: "GET",
    path: "/same",
  });
  assert.equal(same.text, "ok");
  assert.equal(followed, true);
  await expectCode(
    client.request({ serviceKey: "local", method: "GET", path: "/cross" }),
    "redirect-blocked",
  );
  await expectCode(
    client.request({
      serviceKey: "local",
      method: "POST",
      path: "/post",
      body: "do-not-replay",
    }),
    "redirect-blocked",
  );
});

test("blocks private DNS answers unless configured and rejects IPv4-mapped IPv6", async () => {
  const publicClient = new EgressClient(
    [{ key: "public", origin: "https://public.test:443" }],
    {
      resolver: async () => ["10.1.2.3"],
    },
  );
  await expectCode(
    publicClient.request({ serviceKey: "public", method: "GET", path: "/" }),
    "address-blocked",
  );

  const mappedClient = new EgressClient(
    [{ key: "mapped", origin: "http://mapped.test:80", allowPrivate: true }],
    {
      resolver: async () => ["::ffff:127.0.0.1"],
    },
  );
  await expectCode(
    mappedClient.request({ serviceKey: "mapped", method: "GET", path: "/" }),
    "address-blocked",
  );

  const loopbackClient = new EgressClient(
    [{ key: "loopback", origin: "https://loopback.test:443" }],
    { resolver: async () => ["::1"] },
  );
  await expectCode(
    loopbackClient.request({
      serviceKey: "loopback",
      method: "GET",
      path: "/",
    }),
    "address-blocked",
  );
});

test("counts chunked response bytes and applies deadline and AbortSignal", async (t) => {
  const fixture = await listen((request, response) => {
    if (request.url === "/large") {
      response.write("123");
      response.end("456");
      return;
    }
    setTimeout(() => response.end("late"), 500);
  });
  t.after(() => close(fixture.server));
  const resolver = async (): Promise<readonly string[]> => ["127.0.0.1"];

  const limited = localClient(fixture.origin, resolver, {
    maxResponseBytes: 5,
  });
  await expectCode(
    limited.request({ serviceKey: "local", method: "GET", path: "/large" }),
    "response-too-large",
  );
  const deadline = localClient(fixture.origin, resolver, { deadlineMs: 30 });
  await expectCode(
    deadline.request({ serviceKey: "local", method: "GET", path: "/slow" }),
    "deadline",
  );

  let resolverAborted = false;
  const dnsDeadline = localClient(
    fixture.origin,
    async (_hostname, signal) =>
      new Promise<readonly string[]>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            resolverAborted = true;
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      }),
    { deadlineMs: 30 },
  );
  await expectCode(
    dnsDeadline.request({ serviceKey: "local", method: "GET", path: "/slow" }),
    "deadline",
  );
  assert.equal(resolverAborted, true);

  const controller = new AbortController();
  const aborted = localClient(fixture.origin, resolver, { deadlineMs: 1000 });
  const pending = aborted.request({
    serviceKey: "local",
    method: "GET",
    path: "/slow",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await expectCode(pending, "aborted");
});

test("bounds request text, rejects compressed responses, and does not expose errors", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { "Content-Encoding": "gzip" });
    response.end("compressed");
  });
  t.after(() => close(fixture.server));
  const resolver = async (): Promise<readonly string[]> => ["127.0.0.1"];
  const client = localClient(fixture.origin, resolver, { maxRequestBytes: 3 });
  await expectCode(
    client.request({
      serviceKey: "local",
      method: "POST",
      path: "/",
      body: "1234",
    }),
    "request-too-large",
  );
  await expectCode(
    client.request({
      serviceKey: "local",
      method: "GET",
      path: "/1234",
    }),
    "request-too-large",
  );
  await expectCode(
    client.request({ serviceKey: "local", method: "GET", path: "/" }),
    "response-encoding",
  );

  const failing = new EgressClient(
    [{ key: "fail", origin: "https://safe.test:443", secret: "do-not-leak" }],
    {
      resolver: async () => {
        throw new Error("do-not-leak");
      },
    },
  );
  await assert.rejects(
    failing.request({ serviceKey: "fail", method: "GET", path: "/" }),
    (error: unknown) => {
      return (
        error instanceof EgressError &&
        !error.message.includes("do-not-leak") &&
        error.code === "dns-failed"
      );
    },
  );
});

test("supports default resolver for local IPv4 and IPv6 literals without resolver override", async (t) => {
  const ipv4Fixture = await listen((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ipv4-ok");
  });
  t.after(() => close(ipv4Fixture.server));
  const ipv4Port = new URL(ipv4Fixture.origin).port;
  const ipv4Client = new EgressClient([
    {
      key: "ipv4-literal",
      origin: `http://127.0.0.1:${ipv4Port}`,
      allowPrivate: true,
    },
  ]);
  const ipv4Res = await ipv4Client.request({
    serviceKey: "ipv4-literal",
    method: "GET",
    path: "/test",
  });
  assert.equal(ipv4Res.status, 200);
  assert.equal(ipv4Res.text, "ipv4-ok");

  const resolverBypassClient = new EgressClient(
    [
      {
        key: "literal-bypass",
        origin: `http://127.0.0.1:${ipv4Port}`,
        allowPrivate: true,
      },
    ],
    {
      resolver: async () => {
        throw new Error("resolver should not be called for IP literals");
      },
    },
  );
  const bypassRes = await resolverBypassClient.request({
    serviceKey: "literal-bypass",
    method: "GET",
    path: "/test",
  });
  assert.equal(bypassRes.status, 200);
  assert.equal(bypassRes.text, "ipv4-ok");

  const ipv6Fixture = await listenIpv6((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ipv6-ok");
  });
  if (ipv6Fixture) {
    t.after(() => close(ipv6Fixture.server));
    const ipv6Client = new EgressClient([
      {
        key: "ipv6-literal",
        origin: ipv6Fixture.origin,
        allowPrivate: true,
      },
    ]);
    const ipv6Res = await ipv6Client.request({
      serviceKey: "ipv6-literal",
      method: "GET",
      path: "/test-v6",
    });
    assert.equal(ipv6Res.status, 200);
    assert.equal(ipv6Res.text, "ipv6-ok");
  }
});

test("allows maxRedirects=0 and rejects negative or invalid options", async (t) => {
  const fixture = await listen((_request, response) => {
    response.writeHead(302, { Location: "/target" });
    response.end();
  });
  t.after(() => close(fixture.server));
  const resolver = async (): Promise<readonly string[]> => ["127.0.0.1"];
  const zeroRedirectClient = localClient(fixture.origin, resolver, {
    maxRedirects: 0,
  });
  await expectCode(
    zeroRedirectClient.request({
      serviceKey: "local",
      method: "GET",
      path: "/redirect",
    }),
    "redirect-blocked",
  );

  assert.throws(
    () =>
      new EgressClient(
        [{ key: "x", origin: "http://127.0.0.1:80", allowPrivate: true }],
        { maxRedirects: -1 },
      ),
    (error: unknown) =>
      error instanceof EgressError && error.code === "invalid-config",
  );
});

test("validates fixed headers with node validateHeaderName/validateHeaderValue and hides secrets", () => {
  assert.throws(
    () =>
      new EgressClient([
        {
          key: "bad-name",
          origin: "https://example.test:443",
          headers: { "bad header": "value" },
        },
      ]),
    (error: unknown) =>
      error instanceof EgressError && error.code === "invalid-config",
  );

  assert.throws(
    () =>
      new EgressClient([
        {
          key: "bad-val",
          origin: "https://example.test:443",
          headers: { "X-Secret": "bad\r\nval" },
        },
      ]),
    (error: unknown) =>
      error instanceof EgressError && error.code === "invalid-config",
  );

  assert.throws(
    () =>
      new EgressClient([
        {
          key: "forbidden-hdr",
          origin: "https://example.test:443",
          headers: { host: "other.test" },
        },
      ]),
    (error: unknown) =>
      error instanceof EgressError && error.code === "invalid-config",
  );
});

test("blocks test subnet 192.0.2 and IPv4-compatible IPv6 addresses", async () => {
  const testNetClient = new EgressClient(
    [{ key: "test-net", origin: "https://testnet.test:443" }],
    { resolver: async () => ["192.0.2.1"] },
  );
  await expectCode(
    testNetClient.request({
      serviceKey: "test-net",
      method: "GET",
      path: "/",
    }),
    "address-blocked",
  );

  const compat127 = new EgressClient(
    [{ key: "compat1", origin: "http://compat1.test:80", allowPrivate: true }],
    { resolver: async () => ["::127.0.0.1"] },
  );
  await expectCode(
    compat127.request({ serviceKey: "compat1", method: "GET", path: "/" }),
    "address-blocked",
  );

  const compatMeta = new EgressClient(
    [{ key: "compat2", origin: "http://compat2.test:80", allowPrivate: true }],
    { resolver: async () => ["::169.254.169.254"] },
  );
  await expectCode(
    compatMeta.request({ serviceKey: "compat2", method: "GET", path: "/" }),
    "address-blocked",
  );

  const unspecified = new EgressClient(
    [{ key: "unspec", origin: "http://unspec.test:80", allowPrivate: true }],
    { resolver: async () => ["::"] },
  );
  await expectCode(
    unspecified.request({ serviceKey: "unspec", method: "GET", path: "/" }),
    "address-blocked",
  );
});
