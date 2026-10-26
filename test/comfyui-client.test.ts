import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  ComfyBackendClient,
  ComfyBackendError,
} from "../src/comfyui/client.js";

async function fixture(
  handler: (
    path: string,
    method: string,
    body: string,
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
      const result = handler(path, request.method ?? "", body);
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
