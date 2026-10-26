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
  source.graph["2"]!.inputs.value = "mutated caller";
  assert.equal(policy.render().graph["2"]!.inputs.value, "test prompt");
  const one = policy.render({ steps: 30, prompt: "test prompt" });
  assert.equal(one.graph["1"]!.inputs.value, 30);
  assert.deepEqual(one.outputNodes, ["5"]);
  one.graph["1"]!.inputs.value = 4;
  one.outputNodes.push("1");
  assert.equal(policy.render().graph["1"]!.inputs.value, 20);
  assert.deepEqual(policy.render().outputNodes, ["5"]);
});

test("enforces integer bounds and steps, enum membership, and string limits", () => {
  const source = fixture();
  source.variables.sampler = {
    nodeId: "2",
    input: "sampler",
    type: "enum",
    values: ["a", "b"],
  };
  source.graph["2"]!.inputs.sampler = "a";
  source.variables.prompt = {
    nodeId: "2",
    input: "value",
    type: "string",
    maxLength: 4,
  };
  source.graph["2"]!.inputs.value = "four";
  source.graph["1"]!.inputs.value = 3;
  source.variables.steps = {
    nodeId: "1",
    input: "value",
    type: "integer",
    min: 3,
    max: 9,
    step: 3,
  };
  const policy = new ComfyWorkflowPolicy(source);
  assert.deepEqual(
    policy.render({ steps: 6, sampler: "b", prompt: "four" }).graph["2"]!.inputs
      .sampler,
    "b",
  );
  for (const invalid of [
    { steps: 2 },
    { steps: 10 },
    { steps: 4 },
    { sampler: "missing" },
    { prompt: "12345" },
  ])
    assert.throws(() => policy.render(invalid));
  const badDefault = fixture();
  badDefault.graph["1"]!.inputs.value = 51;
  assert.throws(() => new ComfyWorkflowPolicy(badDefault));
  const badStringDefault = fixture();
  badStringDefault.variables.prompt = {
    nodeId: "2",
    input: "value",
    type: "string",
    maxLength: 4,
  };
  assert.throws(() => new ComfyWorkflowPolicy(badStringDefault));
});

test("rejects unknown variables, path-like selection, and malformed policy objects", () => {
  const policy = new ComfyWorkflowPolicy(fixture());
  assert.throws(() => policy.render({ workflow: "../other.json" }));
  assert.throws(() => new ComfyWorkflowPolicy({ ...fixture(), id: "../path" }));
  assert.throws(
    () => new ComfyWorkflowPolicy({ ...fixture(), unexpected: true } as never),
  );
  let getterCalled = false;
  const getter = fixture();
  Object.defineProperty(getter, "id", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "t2i";
    },
  });
  assert.throws(() => new ComfyWorkflowPolicy(getter));
  assert.equal(getterCalled, false);
  const poisoned = fixture();
  Object.defineProperty(poisoned.graph["2"]!.inputs, "__proto__", {
    value: "bad",
    enumerable: true,
  });
  assert.throws(() => new ComfyWorkflowPolicy(poisoned));
});

test("rejects duplicate or missing bindings and malformed or dangling numeric links", () => {
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
  for (const slot of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const badLink = fixture();
    badLink.graph["4"]!.inputs.text = ["2", slot];
    assert.throws(() => new ComfyWorkflowPolicy(badLink));
  }
  const dangling = fixture();
  dangling.graph["4"]!.inputs.text = ["99", 0];
  assert.throws(() => new ComfyWorkflowPolicy(dangling));
  const ordinary = fixture();
  ordinary.graph["4"]!.inputs.text = ["literal", "not-a-slot"];
  assert.doesNotThrow(() => new ComfyWorkflowPolicy(ordinary));
});

test("limits outputs and serialized graph size at compile and render time", () => {
  for (const outputs of [[], Array(9).fill("5"), ["missing"], ["5", "5"]]) {
    const source = fixture();
    source.outputNodes = outputs;
    assert.throws(() => new ComfyWorkflowPolicy(source));
  }
  const growth = fixture();
  growth.graph["6"] = {
    class_type: "PrimitiveString",
    inputs: { value: "x".repeat(256_000) },
  };
  growth.variables.grow = {
    nodeId: "2",
    input: "grow",
    type: "string",
    maxLength: 8192,
  };
  growth.graph["2"]!.inputs.grow = "";
  const policy = new ComfyWorkflowPolicy(growth);
  assert.throws(() => policy.render({ grow: "y".repeat(8192) }));
  const tooLarge = fixture();
  tooLarge.graph["2"]!.inputs.value = "x".repeat(256 * 1024);
  assert.throws(() => new ComfyWorkflowPolicy(tooLarge));
});

test("validated policy cannot be replaced or rebound at runtime", () => {
  const policy = new ComfyWorkflowPolicy(fixture());
  const definition = policy.definition;
  const replacement = fixture();
  replacement.outputNodes = ["1"];
  assert.equal(Reflect.set(policy, "definition", replacement), false);
  assert.throws(() =>
    Object.defineProperty(policy, "definition", { value: replacement }),
  );
  assert.equal(
    Reflect.set(definition.graph["2"]!.inputs, "value", "mutated"),
    false,
  );
  assert.equal(policy.definition, definition);
  assert.deepEqual(policy.render().outputNodes, ["5"]);
  assert.equal(policy.render().graph["2"]!.inputs.value, "test prompt");
  assert.throws(() => policy.render({ undeclared: "test prompt" }));
});
