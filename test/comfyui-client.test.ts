import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  ComfyBackendClient,
  ComfyBackendError,
  comfyUploadPath,
} from "../src/comfyui/client.js";

async function fixture(
  handler: (
    path: string,
    method: string,
    body: string,
    rawBody: Buffer,
    contentType: string,
  ) => { status?: number; body?: string | Buffer },
): Promise<{ server: Server; client: ComfyBackendClient; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push(`${request.method} ${path}`);
      const result = handler(
        path,
        request.method ?? "",
        body,
        Buffer.concat(chunks),
        request.headers["content-type"] ?? "",
      );
      response.statusCode = result.status ?? 200;
      response.end(result.body ?? "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new ComfyBackendClient({
    key: "operator",
    origin: `http://127.0.0.1:${address.port}`,
    allowPrivate: true,
  });
  return { server, client, calls };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function rejectsCode(
  action: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof ComfyBackendError && error.code === code,
  );
}

test("submits serialized text graph once and treats ambiguous responses as unknown", async (t) => {
  let posted = "";
  const f = await fixture((_path, _method, body) => {
    posted = body;
    return { body: '{"prompt_id":"job_1"}' };
  });
  t.after(() => close(f.server));
  assert.equal(
    await f.client.submit({ "1": { class_type: "LoadImage" } }, "nonce"),
    "job_1",
  );
  assert.deepEqual(JSON.parse(posted), {
    prompt: { "1": { class_type: "LoadImage" } },
    client_id: "nonce",
  });

  const malformed = await fixture(() => ({ body: '{"prompt_id":"bad/id"}' }));
  t.after(() => close(malformed.server));
  await rejectsCode(malformed.client.submit({}, "n"), "submission-unknown");
  assert.equal(malformed.calls.length, 1);
});

test("history exposes only declared output nodes and validates safe image references", async (t) => {
  const body = JSON.stringify({
    p1: {
      status: { status_str: "success", completed: true },
      outputs: {
        chosen: {
          images: [
            { filename: "good.webp", subfolder: "folder/run", type: "output" },
          ],
        },
        other: { images: [{ filename: "ignored.png", type: "output" }] },
      },
    },
  });
  const f = await fixture(() => ({ body }));
  t.after(() => close(f.server));
  assert.deepEqual(await f.client.history("p1", ["chosen"]), {
    state: "complete",
    images: [
      { filename: "good.webp", subfolder: "folder/run", type: "output" },
    ],
  });
  await rejectsCode(f.client.history("p1", ["../chosen"]), "history-invalid");

  const invalid = await fixture(() => ({
    body: JSON.stringify({
      p1: {
        status: { status_str: "success", completed: true },
        outputs: {
          chosen: { images: [{ filename: "../escape.png", type: "output" }] },
        },
      },
    }),
  }));
  t.after(() => close(invalid.server));
  await rejectsCode(
    invalid.client.history("p1", ["chosen"]),
    "history-invalid",
  );
  await rejectsCode(
    invalid.client.history("../p1", ["chosen"]),
    "history-invalid",
  );
});

test("downloads exact bytes and maps malformed/non-200 results to fixed errors", async (t) => {
  const bytes = Buffer.from([0x89, 0x50, 0xff, 0x00]);
  const f = await fixture((path) =>
    path.startsWith("/view?")
      ? { body: bytes }
      : { status: 500, body: "secret" },
  );
  t.after(() => close(f.server));
  assert.deepEqual(
    await f.client.download({ filename: "image.png", type: "output" }),
    bytes,
  );
  assert.match(f.calls[0] ?? "", /^GET \/view\?/u);
  await rejectsCode(
    f.client.download({ filename: "../secret.png", type: "output" }),
    "download-failed",
  );
});

test("Comfy-shaped history supports pending empty objects and root-level PNG outputs", async (t) => {
  const f = await fixture((path) => {
    if (path === "/history/pending") return { body: "{}" };
    return {
      body: JSON.stringify({
        real_id: {
          status: { status_str: "success", completed: true },
          outputs: {
            save: {
              images: [
                {
                  filename: "ComfyUI_00001_.png",
                  subfolder: "",
                  type: "output",
                },
              ],
            },
          },
        },
      }),
    };
  });
  t.after(() => close(f.server));
  assert.deepEqual(await f.client.history("pending", ["save"]), {
    state: "pending",
  });
  assert.deepEqual(await f.client.history("real_id", ["save"]), {
    state: "complete",
    images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }],
  });
});

test("history requires bounded unique outputs and nonempty selected successful images", async (t) => {
  const f = await fixture((_path) => ({
    body: JSON.stringify({
      p1: {
        status: { status_str: "success", completed: true },
        outputs: {
          unrelated: { images: [{ filename: "x.png", type: "output" }] },
        },
      },
    }),
  }));
  t.after(() => close(f.server));
  await rejectsCode(f.client.history("p1", []), "history-invalid");
  await rejectsCode(
    f.client.history("p1", ["save", "save"]),
    "history-invalid",
  );
  await rejectsCode(f.client.history("p1", ["save"]), "history-invalid");
});

test("uploads exact binary in bounded multipart with owner-scoped deterministic path", async (t) => {
  const bytes = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x89, 0x50, 0x0d, 0x0a]),
    Buffer.from(
      '\r\n------hitch-comfy-upload-v1\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\nfalse',
    ),
  ]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const expected = comfyUploadPath("owner-A", hash, "image/jpeg");
  let multipart: Uint8Array = new Uint8Array(0);
  let uploadContentType = "";
  const f = await fixture((path, method, _body, rawBody, contentType) => {
    if (path !== "/upload/image" || method !== "POST") return { status: 404 };
    multipart = rawBody;
    uploadContentType = contentType;
    const name = expected.slice("hitch/".length);
    return {
      body: JSON.stringify({ name, subfolder: "hitch", type: "input" }),
    };
  });
  t.after(() => close(f.server));
  assert.equal(await f.client.upload(bytes, "image/jpeg", "owner-A"), expected);
  assert.notEqual(Buffer.from(multipart).indexOf(bytes), -1);
  assert.match(expected, /^hitch\/[a-f0-9]{64}\.jpg$/u);
  const wire = Buffer.from(multipart).toString("latin1");
  assert.match(wire, /Content-Type: image\/jpeg\r\n\r\n/u);
  const boundary = uploadContentType.match(
    /boundary=(----hitch-[a-f0-9]{48})/u,
  )?.[1];
  assert.ok(boundary);
  assert.notEqual(boundary, "----hitch-comfy-upload-v1");
  assert.match(wire, /name="type"\r\n\r\ninput/u);
  assert.match(wire, /name="subfolder"\r\n\r\nhitch/u);
  assert.match(wire, /name="overwrite"\r\n\r\ntrue/u);
  assert.notEqual(comfyUploadPath("owner-B", hash, "image/jpeg"), expected);
  assert.equal(comfyUploadPath("owner-A", hash, "image/jpeg"), expected);
});

test("upload retains immutable constructor origin and trusted headers snapshot", async (t) => {
  let firstCalls = 0;
  let secondCalls = 0;
  let authorization = "";
  const first = createServer((request, response) => {
    firstCalls += 1;
    authorization = request.headers.authorization ?? "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const wire = Buffer.concat(chunks).toString("latin1");
      const name = wire.match(/filename="([^"]+)"/u)?.[1] ?? "";
      response.end(JSON.stringify({ name, subfolder: "hitch", type: "input" }));
    });
  });
  const second = createServer((_request, response) => {
    secondCalls += 1;
    response.end("{}");
  });
  await Promise.all([
    new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve)),
  ]);
  t.after(async () => {
    await close(first);
    await close(second);
  });
  const firstAddress = first.address();
  const secondAddress = second.address();
  assert.ok(firstAddress && typeof firstAddress === "object");
  assert.ok(secondAddress && typeof secondAddress === "object");
  const config = {
    key: "operator",
    origin: `http://127.0.0.1:${firstAddress.port}`,
    allowPrivate: true,
    headers: { Authorization: "Bearer original" },
  };
  const client = new ComfyBackendClient(config);
  config.origin = `http://127.0.0.1:${secondAddress.port}`;
  config.headers.Authorization = "Bearer changed";
  await client.upload(Buffer.from("safe"), "image/png", "owner");
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
  assert.equal(authorization, "Bearer original");
});

test("historyMedia reads PreviewVideo animated/images metadata and ignores undeclared nodes", async (t) => {
  const f = await fixture(() => ({
    body: JSON.stringify({
      p1: {
        status: { status_str: "success", completed: true },
        outputs: {
          chosen: {
            images: [{ filename: "clip.mp4", subfolder: "", type: "output" }],
            animated: [true],
          },
          unrelated: {
            images: [{ filename: "ignored.mp4", type: "output" }],
            animated: [true],
          },
        },
      },
    }),
  }));
  t.after(() => close(f.server));
  assert.deepEqual(await f.client.historyMedia("p1", ["chosen"], "video"), {
    state: "complete",
    outputs: [
      { filename: "clip.mp4", subfolder: "", type: "output", kind: "video" },
    ],
  });
  await rejectsCode(
    f.client.historyMedia("p1", ["chosen"], "image"),
    "history-invalid",
  );
  const unavailable = await fixture(() => ({ status: 503, body: "temporary" }));
  t.after(() => close(unavailable.server));
  await rejectsCode(
    unavailable.client.historyMedia("p1", ["chosen"], "video"),
    "history-unavailable",
  );
});

test("cancellation parses exact backend result, sanitizes malformed/errors, and never interrupts globally", async (t) => {
  const f = await fixture((path) => {
    if (path.endsWith("/true/cancel"))
      return { status: 200, body: '{"cancelled":true}' };
    if (path.endsWith("/false/cancel"))
      return { status: 200, body: '{"cancelled":false}' };
    if (path.endsWith("/bad/cancel")) return { status: 200, body: "not-json" };
    if (path.endsWith("/error/cancel")) return { status: 500, body: "secret" };
    return { status: 405 };
  });
  t.after(() => close(f.server));
  assert.equal(await f.client.cancel("true"), true);
  assert.equal(await f.client.cancel("false"), false);
  assert.equal(await f.client.cancel("legacy"), "unsupported");
  await rejectsCode(f.client.cancel("bad"), "cancel-failed");
  await rejectsCode(f.client.cancel("error"), "cancel-failed");
  assert.deepEqual(f.calls, [
    "POST /api/jobs/true/cancel",
    "POST /api/jobs/false/cancel",
    "POST /api/jobs/legacy/cancel",
    "POST /api/jobs/bad/cancel",
    "POST /api/jobs/error/cancel",
  ]);
});

test("upload MIME table never accepts inherited object property names", () => {
  for (const mime of ["constructor", "toString", "__proto__"])
    assert.throws(() => comfyUploadPath("owner", "0".repeat(64), mime));
});
