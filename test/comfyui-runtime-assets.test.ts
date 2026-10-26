import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const assets = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist/sandbox",
);
test("ComfyUI runtime extension asset is readonly and manifest-attested", () => {
  const extension = join(assets, "pi-comfyui.ts");
  const bytes = readFileSync(extension);
  const manifest = JSON.parse(
    readFileSync(join(assets, "tools-manifest.json"), "utf8"),
  ) as { assets: Record<string, string> };
  assert.equal(statSync(extension).mode & 0o777, 0o444);
  assert.equal(
    manifest.assets["pi-comfyui.ts"],
    createHash("sha256").update(bytes).digest("hex"),
  );
  const text = bytes.toString("utf8");
  for (const tool of [
    "paint",
    "paint_job_cancel",
    "paint_job_status",
    "paint_list_workflows",
  ])
    assert.match(text, new RegExp(`"${tool}"`, "u"));
});
