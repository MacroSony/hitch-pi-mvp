import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createComfyResultAttachmentHandler,
  MAX_COMFY_PREVIEW_BYTES,
} from "../src/comfyui/attachments.js";
import { MediaStore } from "../src/media/media-store.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "hitch-result-attachments-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inbox = join(root, "inbox");
  mkdirSync(inbox, { mode: 0o700 });
  const media = new MediaStore(root, 0);
  const image = () =>
    media.ingest(
      "owner",
      (async function* () {
        yield png;
      })(),
      { expectImage: true, displayName: "fixture.png" },
    );
  return { root, inbox, media, image };
}

test("result attachment produces native preview and read-only exact original, with per-Turn budgets", async (t) => {
  const e = setup(t);
  const a = await e.image();
  const attach = createComfyResultAttachmentHandler({
    ...e,
    userId: "owner",
    visualInput: true,
  });
  const first = await attach(a, true);
  assert.match(first.path, /^\/inbox\/results\/[A-Za-z0-9._-]+\.png$/);
  assert.ok(
    first.preview,
    "pinned image resize API must provide a real preview",
  );
  assert.ok(
    Buffer.from(first.preview.data, "base64").length <= MAX_COMFY_PREVIEW_BYTES,
  );
  const original = join(e.inbox, first.path.slice("/inbox/".length));
  assert.deepEqual(readFileSync(original), png);
  assert.equal(statSync(original).mode & 0o777, 0o400);
  assert.equal(first.sha256, a.sha256);
  const destination = join(e.root, "copy.png");
  copyFileSync(original, destination);
  assert.deepEqual(readFileSync(destination), png);
  assert.ok((await attach(a, true)).preview);
  assert.equal(
    (await attach(a, true)).preview,
    undefined,
    "repeated calls cannot inflate image RPC budget",
  );
  await attach(await e.image(), false);
  const third = await e.image();
  await assert.rejects(() => attach(third, false), /limit/);
  await assert.rejects(() => attach({ ...a, userId: "foreign" }, true));
});

test("nonvisual model gets no image block and result directory symlinks are refused", async (t) => {
  const e = setup(t);
  const a = await e.image();
  const attach = createComfyResultAttachmentHandler({
    ...e,
    userId: "owner",
    visualInput: false,
  });
  assert.equal((await attach(a, true)).preview, undefined);
  const otherInbox = join(e.root, "other-inbox"),
    outside = join(e.root, "outside");
  mkdirSync(otherInbox, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(otherInbox, "results"));
  const malicious = createComfyResultAttachmentHandler({
    inbox: otherInbox,
    media: e.media,
    userId: "owner",
    visualInput: true,
  });
  await assert.rejects(() => malicious(a, true));
  assert.deepEqual(readdirSync(outside), []);
});
