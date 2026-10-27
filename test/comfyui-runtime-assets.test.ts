import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { COMFY_TOOL_NAMES } from "../src/comfyui/types.js";

const assets = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../dist/sandbox",
);
test("ComfyUI runtime extension asset is readonly and manifest-attested", () => {
  const extension = join(assets, "pi-comfyui.ts");
  const bytes = readFileSync(extension);
  const manifest = JSON.parse(
    readFileSync(join(assets, "tools-manifest.json"), "utf8"),
  ) as {
    assets: Record<string, string>;
    optionalTools: Record<string, { asset: string }>;
  };
  assert.equal(statSync(extension).mode & 0o777, 0o444);
  assert.equal(
    manifest.assets["pi-comfyui.ts"],
    createHash("sha256").update(bytes).digest("hex"),
  );
  const text = bytes.toString("utf8");
  for (const tool of COMFY_TOOL_NAMES)
    assert.match(text, new RegExp(`"${tool}"`, "u"));
  assert.deepEqual(
    Object.entries(manifest.optionalTools)
      .filter(([, entry]) => entry.asset === "pi-comfyui.ts")
      .map(([name]) => name)
      .sort(),
    [...COMFY_TOOL_NAMES].sort(),
  );
});

test("built Paint extension registers all six tools and details has a required exact-ID schema", async () => {
  // Native Node TypeScript stripping; no Pi controller, provider, backend or channel.
  const extension = await import(
    pathToFileURL(join(assets, "pi-comfyui.ts")).href
  );
  const registered: {
    name: string;
    description: string;
    parameters: {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<
        string,
        { type: string; minLength: number; maxLength: number; pattern: string }
      >;
    };
  }[] = [];
  extension.default({
    registerTool(tool: (typeof registered)[number]) {
      registered.push(tool);
    },
  });
  assert.deepEqual(
    registered.map((tool) => tool.name).sort(),
    [...COMFY_TOOL_NAMES].sort(),
  );
  const details = registered.find((tool) => tool.name === "paint_get_details")!;
  assert.match(details.description, /\[NOTE\]/);
  const schema = details.parameters;
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["workflow"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), ["workflow"]);
  assert.equal(schema.properties.workflow!.type, "string");
  assert.equal(schema.properties.workflow!.minLength, 1);
  assert.equal(schema.properties.workflow!.maxLength, 64);
  const pattern = new RegExp(schema.properties.workflow!.pattern);
  assert.ok(pattern.test("anima"));
  for (const invalid of [
    "",
    "../anima",
    "anima\n",
    "anima.json",
    "/private/anima",
    "a".repeat(65),
  ])
    assert.ok(!pattern.test(invalid));
});
