import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComfyBackendClient } from "../src/comfyui/client.js";
import { ComfyWorkflowPolicy } from "../src/comfyui/workflow.js";
import { MediaStore } from "../src/media/media-store.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// Protocol simulation, not real Comfy execution or image generation.
test("Comfy foundation renders a fixed graph, polls a fake backend, and imports validated owner media", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hitch-comfy-foundation-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = new ComfyWorkflowPolicy({
    id: "fixture",
    graph: {
      "1": { class_type: "PrimitiveString", inputs: { value: "test prompt" } },
      "2": {
        class_type: "SaveImage",
        inputs: { filename_prefix: "fixture", images: ["1", 0] },
      },
    },
    variables: {
      prompt: { nodeId: "1", input: "value", type: "string", maxLength: 100 },
    },
    outputNodes: ["2"],
  });
  const rendered = policy.render({ prompt: "another test prompt" });
  let historyCalls = 0;
  let submits = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    if (req.method === "POST" && url.pathname === "/prompt") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.prompt["1"].inputs.value, "another test prompt");
      assert.equal(request.client_id, "fixture_nonce");
      submits += 1;
      res.end(JSON.stringify({ prompt_id: "backend_1" }));
    } else if (url.pathname === "/history/backend_1") {
      historyCalls += 1;
      res.end(
        JSON.stringify(
          historyCalls === 1
            ? {}
            : {
                backend_1: {
                  status: { completed: true, status_str: "success" },
                  outputs: {
                    "2": {
                      images: [
                        {
                          filename: "fixture.png",
                          subfolder: "",
                          type: "output",
                        },
                      ],
                    },
                    "99": {
                      images: [
                        {
                          filename: "not-selected.png",
                          subfolder: "",
                          type: "output",
                        },
                      ],
                    },
                  },
                },
              },
        ),
      );
    } else if (
      url.pathname === "/view" &&
      url.searchParams.get("filename") === "fixture.png" &&
      url.searchParams.get("type") === "output"
    ) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new ComfyBackendClient({
    key: "fixture",
    origin: `http://127.0.0.1:${address.port}`,
    allowPrivate: true,
  });
  const id = await client.submit(rendered.graph, "fixture_nonce");
  assert.deepEqual(await client.history(id, rendered.outputNodes), {
    state: "pending",
  });
  const complete = await client.history(id, rendered.outputNodes);
  assert.equal(complete.state, "complete");
  if (complete.state !== "complete") assert.fail("expected complete fake job");
  assert.equal(complete.images.length, 1);
  const downloaded = await client.download(complete.images[0]!);
  assert.deepEqual(downloaded, png);
  const media = new MediaStore(root, 0);
  const artifact = await media.ingest(
    "fixture-owner",
    (async function* () {
      yield downloaded;
    })(),
    {
      displayName: "fixture.png",
      advertisedMime: "image/png",
      expectImage: true,
    },
  );
  assert.equal(artifact.userId, "fixture-owner");
  assert.equal(artifact.mediaKind, "image");
  assert.equal(artifact.sha256, createHash("sha256").update(png).digest("hex"));
  assert.deepEqual(readFileSync(media.verifiedObjectPath(artifact)), png);
  assert.throws(() =>
    media.verifiedObjectPath({ ...artifact, userId: "another-owner" }),
  );
  await assert.rejects(
    media.ingest(
      "fixture-owner",
      (async function* () {
        yield Buffer.from("not an image");
      })(),
      {
        displayName: "fake.png",
        advertisedMime: "image/png",
        expectImage: true,
      },
    ),
  );
  assert.equal(submits, 1);
});
