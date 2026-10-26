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

test("media slots accept only host-planned paths and prune optional disconnected loader branches", () => {
  const source = fixture();
  source.graph["6"] = {
    class_type: "LoadImage",
    inputs: { image: "default.png" },
  };
  source.graph["7"] = { class_type: "UseImage", inputs: { image: ["6", 0] } };
  source.graph["5"]!.inputs.images = ["7", 0];
  source.files = {
    ref: {
      nodeId: "6",
      input: "image",
      media: "image",
      optional: true,
      disconnect: [{ nodeId: "7", input: "image" }],
    },
  };
  source.outputKind = "video";
  const policy = new ComfyWorkflowPolicy(source);
  const empty = policy.render();
  assert.equal(empty.outputKind, "video");
  assert.equal("6" in empty.graph, false);
  assert.equal("image" in empty.graph["7"]!.inputs, false);
  const populated = policy.render({}, { ref: `hitch/${"a".repeat(64)}.png` });
  assert.equal(
    populated.graph["6"]!.inputs.image,
    `hitch/${"a".repeat(64)}.png`,
  );
  for (const bad of [
    "default.png",
    "/tmp/a.png",
    "https://x/a.png",
    `hitch/${"A".repeat(64)}.png`,
  ])
    assert.throws(() => policy.render({}, { ref: bad }));
  assert.throws(() =>
    policy.render({}, { unknown: `hitch/${"a".repeat(64)}.png` }),
  );
  const required = fixture();
  required.files = { input: { nodeId: "2", input: "value", media: "image" } };
  assert.throws(() => new ComfyWorkflowPolicy(required));
});

test("number bindings accept bounded finite floats while legacy output shape stays unchanged", () => {
  const source = fixture();
  source.graph["6"] = { class_type: "Duration", inputs: { value: 1.25 } };
  source.variables.duration = {
    nodeId: "6",
    input: "value",
    type: "number",
    min: 0.25,
    max: 5.5,
    step: 0.25,
    values: [],
  };
  source.graph["6"]!.inputs.value = 1.25;
  const policy = new ComfyWorkflowPolicy(source);
  assert.equal(
    policy.render({ duration: 2.75 }).graph["6"]!.inputs.value,
    2.75,
  );
  for (const n of [0, 5.6, 2.7, Infinity, NaN])
    assert.throws(() => policy.render({ duration: n }));
  assert.deepEqual(
    Object.keys(new ComfyWorkflowPolicy(fixture()).render()).sort(),
    ["graph", "outputNodes"],
  );
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

test("Qwen required image upload accepts only the digest-scoped host path", () => {
  const qwen = fixture();
  qwen.graph["8"] = {
    class_type: "LoadImage",
    inputs: { image: "default.png" },
  };
  qwen.files = { image: { nodeId: "8", input: "image", media: "image" } };
  const policy = new ComfyWorkflowPolicy(qwen);
  assert.throws(() => policy.render());
  assert.equal(
    policy.render({}, { image: `hitch/${"b".repeat(64)}.webp` }).graph["8"]!
      .inputs.image,
    `hitch/${"b".repeat(64)}.webp`,
  );
  for (const path of [
    "hitch/../image.png",
    "hitch/xyz.png",
    "hitch/" + "c".repeat(64) + ".gif",
    "C:\\tmp\\image.png",
    "file:///tmp/image.png",
  ])
    assert.throws(() => policy.render({}, { image: path }));
});

test("FL2VA two optional endpoint uploads produce zero, one, or two connected references", () => {
  const fl2va = fixture();
  fl2va.graph["10"] = {
    class_type: "LoadImage",
    inputs: { image: "first-default.png" },
  };
  fl2va.graph["11"] = {
    class_type: "LoadImage",
    inputs: { image: "last-default.png" },
  };
  fl2va.graph["12"] = {
    class_type: "FL2VA",
    inputs: { first: ["10", 0], last: ["11", 0] },
  };
  fl2va.graph["5"]!.inputs.images = ["12", 0];
  fl2va.files = {
    first: {
      nodeId: "10",
      input: "image",
      media: "image",
      optional: true,
      disconnect: [{ nodeId: "12", input: "first" }],
    },
    last: {
      nodeId: "11",
      input: "image",
      media: "image",
      optional: true,
      disconnect: [{ nodeId: "12", input: "last" }],
    },
  };
  const policy = new ComfyWorkflowPolicy(fl2va);
  const zero = policy.render();
  assert.equal("10" in zero.graph, false);
  assert.equal("11" in zero.graph, false);
  assert.equal("first" in zero.graph["12"]!.inputs, false);
  assert.equal("last" in zero.graph["12"]!.inputs, false);
  const one = policy.render({}, { first: `hitch/${"d".repeat(64)}.png` });
  assert.equal("10" in one.graph, true);
  assert.equal("11" in one.graph, false);
  assert.deepEqual(one.graph["12"]!.inputs.first, ["10", 0]);
  assert.equal("last" in one.graph["12"]!.inputs, false);
  const two = policy.render(
    {},
    {
      first: `hitch/${"d".repeat(64)}.png`,
      last: `hitch/${"e".repeat(64)}.png`,
    },
  );
  assert.equal("10" in two.graph, true);
  assert.equal("11" in two.graph, true);
});

test("Ref2VA image, video, and audio optional loader families prune independently without defaults", () => {
  const ref = fixture();
  ref.graph["20"] = {
    class_type: "LoadImage",
    inputs: { image: "secret-image-default.png" },
  };
  ref.graph["21"] = {
    class_type: "ImageCondition",
    inputs: { image: ["20", 0] },
  };
  ref.graph["22"] = {
    class_type: "LoadVideo",
    inputs: { video: "secret-video-default.mp4" },
  };
  ref.graph["23"] = {
    class_type: "GetVideoComponents",
    inputs: { video: ["22", 0] },
  };
  ref.graph["24"] = {
    class_type: "VideoCondition",
    inputs: { video: ["23", 0], audio: ["23", 1] },
  };
  ref.graph["25"] = {
    class_type: "LoadAudio",
    inputs: { audio: "secret-audio-default.wav" },
  };
  ref.graph["26"] = {
    class_type: "AudioCondition",
    inputs: { audio: ["25", 0] },
  };
  ref.graph["5"]!.inputs = {
    image: ["21", 0],
    video: ["24", 0],
    audio: ["26", 0],
  };
  ref.files = {
    image: {
      nodeId: "20",
      input: "image",
      media: "image",
      optional: true,
      disconnect: [{ nodeId: "21", input: "image" }],
    },
    video: {
      nodeId: "22",
      input: "video",
      media: "video",
      optional: true,
      disconnect: [{ nodeId: "23", input: "video" }],
    },
    audio: {
      nodeId: "25",
      input: "audio",
      media: "audio",
      optional: true,
      disconnect: [{ nodeId: "26", input: "audio" }],
    },
  };
  const policy = new ComfyWorkflowPolicy(ref);
  const none = policy.render();
  for (const id of ["20", "22", "25"]) assert.equal(id in none.graph, false);
  assert.equal(JSON.stringify(none.graph).includes("secret-"), false);
  const video = policy.render({}, { video: `hitch/${"f".repeat(64)}.mp4` });
  assert.equal("22" in video.graph, true);
  assert.equal("23" in video.graph, true);
  assert.equal("24" in video.graph, true);
  assert.equal("20" in video.graph, false);
  assert.equal("25" in video.graph, false);
  const all = policy.render(
    {},
    {
      image: `hitch/${"a".repeat(64)}.png`,
      video: `hitch/${"b".repeat(64)}.mp4`,
      audio: `hitch/${"c".repeat(64)}.wav`,
    },
  );
  for (const id of ["20", "21", "22", "23", "24", "25", "26"])
    assert.equal(id in all.graph, true);
});

test("file policy rejects malformed slots, overlap, dangling disconnects, and unsafe reachable defaults", () => {
  const make = (): ComfyWorkflowDefinition => {
    const d = fixture();
    d.graph["30"] = { class_type: "Loader", inputs: { file: "default.png" } };
    d.graph["31"] = { class_type: "Sink", inputs: { file: ["30", 0] } };
    d.graph["5"]!.inputs.images = ["31", 0];
    d.files = {
      slot: {
        nodeId: "30",
        input: "file",
        media: "image",
        optional: true,
        disconnect: [{ nodeId: "31", input: "file" }],
      },
    };
    return d;
  };
  for (const mutate of [
    (d: ComfyWorkflowDefinition) => {
      d.files = { "../bad": d.files!.slot! };
    },
    (d: ComfyWorkflowDefinition) => {
      d.files = { slot: { ...d.files!.slot!, optional: true, disconnect: [] } };
    },
    (d: ComfyWorkflowDefinition) => {
      d.files = {
        slot: {
          ...d.files!.slot!,
          disconnect: [{ nodeId: "missing", input: "x" }],
        },
      };
    },
    (d: ComfyWorkflowDefinition) => {
      d.files = { slot: { ...d.files!.slot!, nodeId: "1", input: "value" } };
    },
    (d: ComfyWorkflowDefinition) => {
      d.files!.slot!.disconnect = [];
    },
  ]) {
    const d = make();
    mutate(d);
    assert.throws(() => new ComfyWorkflowPolicy(d));
  }
  const stillConnected = make();
  stillConnected.files!.slot!.disconnect = [{ nodeId: "31", input: "file" }];
  stillConnected.graph["32"] = {
    class_type: "AlsoUsesLoader",
    inputs: { file: ["30", 0] },
  };
  stillConnected.graph["5"]!.inputs.second = ["32", 0];
  assert.throws(() => new ComfyWorkflowPolicy(stillConnected).render());
  const oversized = make();
  oversized.graph["40"] = {
    class_type: "Large",
    inputs: { data: "z".repeat(260_000) },
  };
  oversized.variables.grow = {
    nodeId: "1",
    input: "extra",
    type: "string",
    maxLength: 8192,
  };
  oversized.graph["1"]!.inputs.extra = "";
  oversized.graph["5"]!.inputs.large = ["40", 0];
  oversized.graph["5"]!.inputs.steps = ["1", 0];
  assert.throws(() =>
    new ComfyWorkflowPolicy(oversized).render({ grow: "y".repeat(8192) }),
  );
});
