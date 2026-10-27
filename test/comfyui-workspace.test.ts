import assert from "node:assert/strict";
import fs, {
  type BigIntStats,
  chmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { materializeComfyWorkspaceResult } from "../src/comfyui/workspace.js";
import { MediaStore } from "../src/media/media-store.js";
import type { RuntimeArtifact } from "../src/runtime/runtime.js";

const INVALID = "Comfy workspace result is unavailable.";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// Tiny legal local CPU-only fixtures; tests neither generate media nor run tools.
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Lf//Z",
  "base64",
);
const webp = Buffer.from(
  "UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoQABAAAgA0JaACdLoAA5gA/vmTb/+QH/+QH/+QH/8gP+IXeyAwAA==",
  "base64",
);
const mp4 = Buffer.from(
  "AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC5W1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHndHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABg21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAKAAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAS5taW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADuc3RibAAAAKJzdHNkAAAAAAAAAAEAAACSYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjAuMzEuMTAyIGxpYngyNjQAAAAAAAAAAAAAABj//wAAACxhdmNDAULACv/hABVnQsAK2nsBEAAAAwAQAAADAUDxImoBAARozg/IAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAAcG1vb2YAAAAQbWZoZAAAAAAAAAABAAAAWHRyYWYAAAAkdGZoZAAAADkAAAABAAAAAAAAAwkAAAQAAAACbwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAABh0cnVuAAAABQAAAAEAAAB4AgAAAAAAAndtZGF0AAACVAYF//9Q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xMCBzY2VuZWN1dD0wIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MACAAAAAE2WIhDoRigACMXHAAEPKOAAIBeAAAABDbWZyYQAAACt0ZnJhAQAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAwkBAQEAAAAQbWZybwAAAAAAAABD",
  "base64",
);

async function fixture(t: TestContext, bytes = png, mimeType = "image/png") {
  const root = mkdtempSync(join(tmpdir(), "hitch-comfy-workspace-"));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const parent = join(root, "workspaces");
  const workspace = join(parent, "alice");
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const media = new MediaStore(data);
  const artifact = Object.freeze(
    await media.ingest(
      "alice",
      (async function* () {
        yield bytes;
      })(),
      {
        advertisedMime: mimeType,
        expectImage: mimeType.startsWith("image/"),
        displayName: "../../model-chosen-destination.exe",
      },
    ),
  );
  const args = { userId: "alice", workspace, artifact, media };
  const shortId = createHash("sha256")
    .update(artifact.id)
    .digest("base64url")
    .slice(0, 16);
  const name = `paint-${shortId}.${
    mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]
  }`;
  return {
    root,
    data,
    parent,
    workspace,
    media,
    artifact,
    args,
    name,
    target: join(workspace, name),
    run: () => materializeComfyWorkspaceResult(args),
  };
}

function assertUnchanged(path: string, before: BigIntStats): void {
  const after = lstatSync(path, { bigint: true });
  // Verification reads may legitimately advance atime (including relatime).
  for (const field of [
    "dev",
    "ino",
    "uid",
    "gid",
    "mode",
    "size",
    "nlink",
    "mtimeNs",
    "ctimeNs",
  ] as const)
    assert.equal(after[field], before[field], field);
}

function rejected(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, INVALID);
    assert.equal(error.cause, undefined);
    return true;
  });
}

for (const [mime, bytes] of [
  ["image/png", png],
  ["image/jpeg", jpeg],
  ["image/webp", webp],
  ["video/mp4", mp4],
] as const) {
  test(`materializes ${mime} with a flat stable sandbox path and exact bytes`, async (t) => {
    const f = await fixture(t, bytes, mime);
    assert.equal(f.artifact.mimeType, mime);
    assert.deepEqual(f.run(), {
      path: `/workspace/${f.name}`,
      relativePath: f.name,
    });
    assert.deepEqual(readFileSync(f.target), bytes);
    const stat = lstatSync(f.target);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.uid, process.getuid!());
    assert.equal(stat.mode & 0o077, 0);
    assert.equal(stat.nlink, 1);
    assert.deepEqual(readdirSync(f.workspace), [f.name]);
  });
}

test("idempotent reuse preserves inode, content, mode and mtime; display name is ignored", async (t) => {
  const f = await fixture(t);
  const first = f.run();
  chmodSync(f.target, 0o400);
  const before = lstatSync(f.target, { bigint: true });
  assert.deepEqual(f.run(), first);
  assert.deepEqual(
    materializeComfyWorkspaceResult({
      ...f.args,
      artifact: { ...f.artifact, displayName: "some-new-name.mp4" },
    }),
    first,
  );
  assertUnchanged(f.target, before);
});

test("rejects wrong owner, oversized/invalid metadata, unsupported MIME and non-image classifications", async (t) => {
  const f = await fixture(t);
  rejected(() => materializeComfyWorkspaceResult({ ...f.args, userId: "bob" }));
  for (const patch of [
    { userId: "bob" },
    { bytes: 10 * 1024 * 1024 + 1 },
    { bytes: 0 },
    { bytes: -1 },
    { bytes: 1.5 },
    { bytes: Number.NaN },
    { id: "../../escape" },
    { storageKey: `bob/${f.artifact.id.slice(9)}.blob` },
    { sha256: "bad" },
    { mimeType: "image/gif" },
    { mimeType: "text/plain", mediaKind: "file" as const },
    { mimeType: "video/mp4", mediaKind: "image" as const },
    { mediaKind: "file" as const },
  ]) {
    rejected(() =>
      materializeComfyWorkspaceResult({
        ...f.args,
        artifact: { ...f.artifact, ...patch },
      }),
    );
  }
  assert.deepEqual(readdirSync(f.workspace), []);
});

test("rejects a real oversized object before writing", async (t) => {
  const f = await fixture(t, Buffer.alloc(10 * 1024 * 1024 + 1), "video/mp4");
  rejected(f.run);
  assert.deepEqual(readdirSync(f.workspace), []);
});

for (const mutation of [
  "corrupt",
  "truncated",
  "writable",
  "symlink",
  "hardlink",
] as const) {
  test(`rejects ${mutation} source object without copying bytes`, async (t) => {
    const f = await fixture(t);
    const source = f.media.objectPath(f.artifact);
    if (mutation === "hardlink") {
      linkSync(source, join(f.root, "source-link"));
    } else if (mutation === "symlink") {
      const moved = join(f.root, "source-original");
      renameSync(source, moved);
      symlinkSync(moved, source);
    } else {
      chmodSync(source, 0o600);
      if (mutation !== "writable") {
        const bytes = Buffer.from(png);
        bytes[40] = bytes[40]! ^ 1;
        writeFileSync(
          source,
          mutation === "truncated" ? bytes.subarray(0, 40) : bytes,
        );
        chmodSync(source, 0o400);
      }
    }
    rejected(f.run);
    assert.deepEqual(readdirSync(f.workspace), []);
  });
}

for (const conflict of [
  "different-size",
  "different-hash",
  "public",
  "directory",
  "symlink",
  "hardlink",
] as const) {
  test(`refuses ${conflict} target and never overwrites the existing inode`, async (t) => {
    const f = await fixture(t);
    const sentinel = join(f.root, "sentinel");
    writeFileSync(sentinel, png, { mode: 0o600 });
    if (conflict === "directory") mkdirSync(f.target, { mode: 0o700 });
    else if (conflict === "symlink") symlinkSync(sentinel, f.target);
    else if (conflict === "hardlink") linkSync(sentinel, f.target);
    else {
      const content = Buffer.from(png);
      if (conflict === "different-hash") content[40] = content[40]! ^ 1;
      writeFileSync(
        f.target,
        conflict === "different-size" ? "conflict" : content,
        {
          mode: 0o600,
        },
      );
      if (conflict === "public") chmodSync(f.target, 0o644);
    }
    const before = lstatSync(f.target, { bigint: true });
    const content = before.isFile() ? readFileSync(f.target) : null;
    rejected(f.run);
    assertUnchanged(f.target, before);
    if (content) assert.deepEqual(readFileSync(f.target), content);
    assert.deepEqual(readFileSync(sentinel), png);
  });
}

test("rejects final-component and ancestor workspace symlinks", async (t) => {
  const f = await fixture(t);
  const link = join(f.root, "alias");
  symlinkSync(f.workspace, link);
  rejected(() =>
    materializeComfyWorkspaceResult({ ...f.args, workspace: link }),
  );
  rmSync(link);
  symlinkSync(f.parent, link);
  rejected(() =>
    materializeComfyWorkspaceResult({
      ...f.args,
      workspace: join(link, "alice"),
    }),
  );
  assert.deepEqual(readdirSync(f.workspace), []);
});

test("rejects noncanonical and nonprivate workspace roots", async (t) => {
  const f = await fixture(t);
  for (const workspace of [
    "relative",
    "/",
    `${f.workspace}/`,
    `${f.workspace}/../alice`,
  ]) {
    rejected(() => materializeComfyWorkspaceResult({ ...f.args, workspace }));
  }
  chmodSync(f.workspace, 0o777);
  rejected(f.run);
  assert.deepEqual(readdirSync(f.workspace), []);
});

class HookMedia extends MediaStore {
  public constructor(
    data: string,
    readonly hook: () => void,
  ) {
    super(data);
  }

  public override verifiedObjectPath(artifact: RuntimeArtifact): string {
    const path = super.verifiedObjectPath(artifact);
    this.hook();
    return path;
  }
}

for (const attack of [
  "rename",
  "swap",
  "symlink-swap",
  "ancestor-rename",
] as const) {
  test(`detects ${attack} after directory open, fails generically and writes nowhere`, async (t) => {
    const f = await fixture(t);
    const moved = join(f.root, "moved");
    const replacement = join(f.root, "replacement");
    mkdirSync(replacement, { mode: 0o700 });
    const media = new HookMedia(f.data, () => {
      if (attack === "ancestor-rename") renameSync(f.parent, moved);
      else {
        renameSync(f.workspace, moved);
        if (attack === "swap") renameSync(replacement, f.workspace);
        if (attack === "symlink-swap") symlinkSync(replacement, f.workspace);
      }
    });
    rejected(() => materializeComfyWorkspaceResult({ ...f.args, media }));
    const original =
      attack === "ancestor-rename" ? join(moved, "alice") : moved;
    assert.deepEqual(readdirSync(original), []);
    if (attack === "swap" || attack === "symlink-swap")
      assert.deepEqual(readdirSync(f.workspace), []);
  });
}

test("rechecks the descriptor after media pathname verification (source TOCTOU)", async (t) => {
  const f = await fixture(t);
  const media = new HookMedia(f.data, () => {
    const source = f.media.objectPath(f.artifact);
    renameSync(source, join(f.root, "original-blob"));
    const corrupt = Buffer.from(png);
    corrupt[40] = corrupt[40]! ^ 1;
    writeFileSync(source, corrupt, { mode: 0o400 });
  });
  rejected(() => materializeComfyWorkspaceResult({ ...f.args, media }));
  assert.deepEqual(readdirSync(f.workspace), []);
});

test("rejects target symlink inserted after directory open", async (t) => {
  const f = await fixture(t);
  const sentinel = join(f.root, "sentinel");
  writeFileSync(sentinel, "keep", { mode: 0o600 });
  const media = new HookMedia(f.data, () => symlinkSync(sentinel, f.target));
  rejected(() => materializeComfyWorkspaceResult({ ...f.args, media }));
  assert.deepEqual(readFileSync(sentinel), Buffer.from("keep"));
  assert.equal(lstatSync(f.target).isSymbolicLink(), true);
});

// Deterministic syscall-boundary injection, restored before any other test runs.
// Exercise mutations after the verified copy, not only before O_EXCL/open.
for (const attack of [
  "modify",
  "replace",
  "hardlink",
  "directory-swap",
] as const) {
  test(`rejects late ${attack} after target verification`, async (t) => {
    const f = await fixture(t);
    const sentinel = join(f.root, "sentinel");
    writeFileSync(sentinel, "never overwrite", { mode: 0o600 });
    const originalFsync = fs.fsyncSync;
    let attacked = false;
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      originalFsync(fd);
      if (attacked || fstatSync(fd).ino !== lstatSync(f.target).ino) return;
      attacked = true;
      if (attack === "modify") {
        const corrupt = Buffer.from(png);
        corrupt[40] = corrupt[40]! ^ 1;
        writeFileSync(f.target, corrupt);
      } else if (attack === "replace") {
        renameSync(f.target, join(f.root, "original-target"));
        symlinkSync(sentinel, f.target);
      } else if (attack === "hardlink") {
        linkSync(f.target, join(f.root, "linked-target"));
      } else {
        renameSync(f.workspace, join(f.root, "moved-workspace"));
        mkdirSync(f.workspace, { mode: 0o700 });
      }
    });
    syncBuiltinESMExports();
    try {
      rejected(f.run);
      assert.equal(attacked, true);
      assert.equal(readFileSync(sentinel, "utf8"), "never overwrite");
      if (attack === "directory-swap")
        assert.deepEqual(readdirSync(f.workspace), []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test("accepts the inclusive 10 MiB bound", async (t) => {
  const free = Buffer.alloc(10 * 1024 * 1024 - mp4.length);
  free.writeUInt32BE(free.length);
  free.write("free", 4, "ascii");
  const bytes = Buffer.concat([mp4, free]);
  const f = await fixture(t, bytes, "video/mp4");
  assert.equal(f.run().relativePath, f.name);
  assert.deepEqual(readFileSync(f.target), bytes);
});
