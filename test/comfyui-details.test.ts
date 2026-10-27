import assert from "node:assert/strict";
import test from "node:test";
import {
  COMFY_DETAILS_MAX_BYTES,
  COMFY_DETAILS_MAX_NOTES_BYTES,
  ComfyWorkflowPolicy,
  type ComfyWorkflowDefinition,
} from "../src/comfyui/workflow.js";

function fixture(): ComfyWorkflowDefinition {
  return {
    id: "anima",
    description: "Operator description, separate from graph notes.",
    graph: {
      note: {
        class_type: "Note",
        _meta: { title: "[NOTE] Instructions" },
        inputs: { text: "Live graph note.", internal: "hidden-note-input" },
      },
      valueNote: {
        class_type: "PrimitiveString",
        _meta: { title: "[NOTE]" },
        inputs: { value: "Value takes precedence.", text: "hidden-fallback" },
      },
      fixed: {
        class_type: "Loader",
        _meta: { title: "[VAR] model" },
        inputs: {
          model: "hidden-model.safetensors",
          steps: 20,
          host: "/private/host/path",
          backend: "https://private.invalid",
          headers: { Authorization: "hidden-secret" },
        },
      },
      params: {
        class_type: "Parameters",
        inputs: { prompt: "", width: 512, duration: 1.5, mode: "a" },
      },
      reference: {
        class_type: "LoadImage",
        inputs: { image: "/private/reference.png" },
      },
      out: { class_type: "SaveImage", inputs: { images: ["params", 0] } },
    },
    variables: {
      prompt: {
        nodeId: "params",
        input: "prompt",
        type: "string",
        maxLength: 8192,
      },
      width: {
        nodeId: "params",
        input: "width",
        type: "integer",
        min: 256,
        max: 1536,
        step: 64,
      },
      duration: {
        nodeId: "params",
        input: "duration",
        type: "number",
        min: 0.5,
        max: 15,
        step: 0.5,
      },
      mode: {
        nodeId: "params",
        input: "mode",
        type: "enum",
        values: ["a", "b"],
      },
    },
    files: {
      reference: { nodeId: "reference", input: "image", media: "image" },
    },
    outputNodes: ["out"],
  };
}

test("details reads current operator graph NOTE text/value, not a description copy or arbitrary graph metadata", () => {
  const source = fixture();
  const policy = new ComfyWorkflowPolicy(source);
  const details = policy.details();
  assert.deepEqual(details, {
    id: "anima",
    description: source.description,
    notes: "Live graph note.\n\nValue takes precedence.",
    notesTruncated: false,
    variables: [
      { name: "prompt", type: "string", maxLength: 8192, default: "" },
      {
        name: "width",
        type: "integer",
        min: 256,
        max: 1536,
        step: 64,
        default: 512,
      },
      {
        name: "duration",
        type: "number",
        min: 0.5,
        max: 15,
        step: 0.5,
        default: 1.5,
      },
      { name: "mode", type: "enum", default: "a", values: ["a", "b"] },
    ],
    files: [{ slot: "reference", media: "image", optional: false }],
    output_kind: "image",
  });
  const serialized = JSON.stringify(details);
  for (const hidden of [
    "hidden-",
    "/private",
    "private.invalid",
    "class_type",
    "nodeId",
    "outputNodes",
    "steps",
    "model",
    "Authorization",
  ])
    assert.ok(!serialized.includes(hidden), hidden);
  source.graph.note!.inputs.text = "Updated graph note.";
  const updated = new ComfyWorkflowPolicy(source).details();
  assert.equal(updated.description, details.description);
  assert.match(updated.notes, /^Updated graph note\./);
  assert.match(policy.details().notes, /^Live graph note\./);
  details.variables[0]!.default = "mutated result";
  assert.equal(policy.details().variables[0]!.default, "");
  assert.throws(() => policy.render({ model: "other", steps: 1 }));
});

test("missing/empty/non-string NOTE is legal, output kind and optional file slots stay public", () => {
  const source = fixture();
  source.graph.note!.inputs.text = {};
  source.graph.valueNote!.inputs = { value: null, text: " " };
  source.outputKind = "video";
  source.files!.reference!.optional = true;
  source.files!.reference!.disconnect = [{ nodeId: "out", input: "images" }];
  const details = new ComfyWorkflowPolicy(source).details();
  assert.equal(details.notes, "");
  assert.equal(details.notesTruncated, false);
  assert.equal(details.output_kind, "video");
  assert.deepEqual(details.files, [
    { slot: "reference", media: "image", optional: true },
  ]);
  delete source.graph.note;
  delete source.graph.valueNote;
  assert.equal(new ComfyWorkflowPolicy(source).details().notes, "");
});

test("details bounds aggregate notes and total escaped JSON, with honest default/enum omissions", () => {
  const source = fixture();
  delete source.files;
  // Two NOTE nodes must share one budget; escapes and multibyte text both count.
  source.graph.note!.inputs.text = "\u0000😀".repeat(3000);
  source.graph.valueNote!.inputs.value = '"\\\n'.repeat(6000);
  source.description = "\u0000".repeat(1024);
  source.variables = {};
  for (let i = 0; i < 16; i++) {
    const name = `enum${i}`;
    const values = Array.from(
      { length: 64 },
      (_, n) => `${n}${"x".repeat(120)}`,
    );
    source.graph.params!.inputs[name] = values[0]!;
    source.variables[name] = {
      nodeId: "params",
      input: name,
      type: "enum",
      values,
    };
  }
  const details = new ComfyWorkflowPolicy(source).details();
  assert.equal(details.notesTruncated, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(details.notes)) <=
      COMFY_DETAILS_MAX_NOTES_BYTES,
  );
  assert.ok(!/[\uD800-\uDBFF]$/.test(details.notes));
  assert.ok(
    Buffer.byteLength(JSON.stringify(details)) <= COMFY_DETAILS_MAX_BYTES,
  );
  assert.equal(details.variables.length, 16);
  assert.ok(details.variables.some((v) => v.valuesOmitted));
  assert.ok(
    details.variables.every(
      (v) => v.default === source.graph.params!.inputs[v.name],
    ),
  );
  const long = fixture();
  long.graph.params!.inputs.prompt = "x".repeat(8192);
  const variable = new ComfyWorkflowPolicy(long).details().variables[0]!;
  assert.equal(variable.defaultOmitted, true);
  assert.equal(Object.hasOwn(variable, "default"), false);
  assert.equal(variable.type, "string");
  assert.equal("maxLength" in variable && variable.maxLength, 8192);
});
