import test from "node:test";
import assert from "node:assert/strict";
import {
  ComfyWorkflowPolicy,
  type ComfyWorkflowDefinition,
} from "../src/comfyui/workflow.js";

function fixture(): ComfyWorkflowDefinition {
  return {
    id: "t2i",
    graph: {
      "1": { class_type: "PrimitiveInt", inputs: { value: 20 } },
      "2": { class_type: "PrimitiveString", inputs: { value: "test prompt" } },
      "3": {
        class_type: "EmptyLatentImage",
        inputs: { width: 512, height: 512, batch_size: ["1", 0] },
      },
      "4": { class_type: "CLIPTextEncode", inputs: { text: ["2", 0] } },
      "5": {
        class_type: "SaveImage",
        inputs: { images: ["3", 0] },
        _meta: { title: "save" },
      },
    },
    variables: {
      steps: {
        nodeId: "1",
        input: "value",
        type: "integer",
        min: 1,
        max: 50,
        step: 1,
      },
      prompt: { nodeId: "2", input: "value", type: "string", maxLength: 80 },
    },
    outputNodes: ["5"],
  };
}

test("compiles trusted t2i defaults and renders independent bound values", () => {
  const source = fixture();
  const policy = new ComfyWorkflowPolicy(source);
  source.graph["2"]!!.inputs.value = "mutated caller";
  assert.equal(policy.render().graph["2"]!.inputs.value, "test prompt");
  const one = policy.render({ steps: 30, prompt: "test prompt" });
  assert.equal(one.graph["1"]!!.inputs.value, 30);
  assert.deepEqual(one.outputNodes, ["5"]);
  one.graph["1"]!!.inputs.value = 4;
  one.outputNodes.push("1");
  assert.equal(policy.render().graph["1"]!.inputs.value, 20);
  assert.deepEqual(policy.render().outputNodes, ["5"]);
});

test("rejects bounds, undeclared variables, and path-like workflow selection", () => {
  const policy = new ComfyWorkflowPolicy(fixture());
  assert.throws(() => policy.render({ steps: 51 }));
  assert.throws(() => policy.render({ workflow: "../other.json" }));
  assert.throws(() => new ComfyWorkflowPolicy({ ...fixture(), id: "../path" }));
});

test("rejects duplicate or missing bindings, missing links, and prototype targets", () => {
  const duplicate = fixture();
  duplicate.variables.other = {
    nodeId: "1",
    input: "value",
    type: "integer",
    min: 1,
    max: 10,
  };
  assert.throws(() => new ComfyWorkflowPolicy(duplicate));
  const missing = fixture();
  missing.variables.steps = {
    nodeId: "99",
    input: "value",
    type: "integer",
    min: 1,
    max: 10,
  };
  assert.throws(() => new ComfyWorkflowPolicy(missing));
  const dangling = fixture();
  dangling.graph["4"]!.inputs.text = ["99", 0];
  assert.throws(() => new ComfyWorkflowPolicy(dangling));
  const poison = JSON.parse(
    '{"id":"t2i","graph":{"1":{"class_type":"PrimitiveInt","inputs":{"value":20}},"2":{"class_type":"PrimitiveString","inputs":{"value":"test prompt"}},"3":{"class_type":"EmptyLatentImage","inputs":{"width":512,"height":512,"batch_size":["1",0]}},"4":{"class_type":"CLIPTextEncode","inputs":{"text":["2",0]}},"5":{"class_type":"SaveImage","inputs":{"images":["3",0]}}},"variables":{"__proto__":{"nodeId":"1","input":"value","type":"integer","min":1,"max":10}},"outputNodes":["5"]}',
  );
  assert.throws(() => new ComfyWorkflowPolicy(poison));
});

test("rejects non-JSON graphs and static resource overages with sanitized failures", () => {
  const circular = fixture();
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  circular.graph["2"]!!.inputs.value = loop as never;
  assert.throws(() => new ComfyWorkflowPolicy(circular), {
    message: "Invalid ComfyUI workflow policy",
  });
  const oversized = fixture();
  oversized.graph["2"]!!.inputs.value = "x".repeat(256 * 1024);
  assert.throws(() => new ComfyWorkflowPolicy(oversized), {
    message: "Invalid ComfyUI workflow policy",
  });
  const many = fixture();
  many.graph = Object.fromEntries(
    Array.from({ length: 257 }, (_, i) => [
      `${i + 1}`,
      { class_type: "Node", inputs: {} },
    ]),
  ) as ComfyWorkflowDefinition["graph"];
  assert.throws(() => new ComfyWorkflowPolicy(many));
});
