export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

export interface ComfyWorkflowDefinition {
  id: string;
  graph: Record<
    string,
    { class_type: string; inputs: Record<string, JSONValue>; _meta?: JSONValue }
  >;
  variables: Record<
    string,
    | { nodeId: string; input: string; type: "string"; maxLength: number }
    | {
        nodeId: string;
        input: string;
        type: "integer";
        min: number;
        max: number;
        step?: number;
      }
    | { nodeId: string; input: string; type: "enum"; values: readonly string[] }
  >;
  outputNodes: readonly string[];
}

export interface RenderedComfyWorkflow {
  graph: ComfyWorkflowDefinition["graph"];
  outputNodes: string[];
}

const BAD = "Invalid ComfyUI workflow policy";
const POISON = new Set(["__proto__", "prototype", "constructor"]);
const SHORT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const hasOwn = (o: object, k: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

function fail(): never {
  throw new Error(BAD);
}
function plain(o: unknown): o is Record<string, unknown> {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}
function keys(o: Record<string, unknown>): string[] {
  const result = Reflect.ownKeys(o);
  if (result.some((k) => typeof k !== "string" || POISON.has(k))) fail();
  for (const k of result as string[]) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !("value" in d) || !d.enumerable) fail();
  }
  return result as string[];
}
function cloneJSON(value: unknown, seen = new Set<object>()): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (typeof value !== "object") fail();
  if (seen.has(value)) fail();
  seen.add(value);
  let out: JSONValue;
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) fail();
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !("value" in d) || !d.enumerable) fail();
    }
    out = value.map((v) => cloneJSON(v, seen));
  } else {
    if (!plain(value)) fail();
    const copy: Record<string, JSONValue> = Object.create(null);
    for (const k of keys(value as Record<string, unknown>))
      copy[k] = cloneJSON((value as Record<string, unknown>)[k], seen);
    out = copy;
  }
  seen.delete(value);
  return out;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
function validateValue(
  binding: ComfyWorkflowDefinition["variables"][string],
  value: unknown,
): JSONValue {
  if (binding.type === "string") {
    if (typeof value !== "string" || value.length > binding.maxLength) fail();
  } else if (binding.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < binding.min ||
      value > binding.max ||
      (binding.step !== undefined && (value - binding.min) % binding.step !== 0)
    )
      fail();
  } else if (typeof value !== "string" || !binding.values.includes(value))
    fail();
  return cloneJSON(value);
}

export class ComfyWorkflowPolicy {
  readonly definition: ComfyWorkflowDefinition;

  constructor(definition: ComfyWorkflowDefinition) {
    try {
      this.definition = freeze(this.compile(definition));
    } catch {
      throw new Error(BAD);
    }
  }

  private compile(source: unknown): ComfyWorkflowDefinition {
    if (!plain(source)) fail();
    if (
      keys(source).some(
        (k) => !["id", "graph", "variables", "outputNodes"].includes(k),
      )
    )
      fail();
    const id = source.id;
    if (typeof id !== "string" || !SHORT_ID.test(id)) fail();
    const graphSource = source.graph;
    const variablesSource = source.variables;
    const outputsSource = source.outputNodes;
    if (
      !plain(graphSource) ||
      !plain(variablesSource) ||
      !Array.isArray(outputsSource)
    )
      fail();
    const graph: ComfyWorkflowDefinition["graph"] = Object.create(null);
    const nodeIds = keys(graphSource);
    if (nodeIds.length < 1 || nodeIds.length > 256) fail();
    for (const nodeId of nodeIds) {
      if (!NODE_ID.test(nodeId)) fail();
      const node = graphSource[nodeId];
      if (!plain(node)) fail();
      const nodeKeys = keys(node);
      if (
        nodeKeys.some((k) => !["class_type", "inputs", "_meta"].includes(k)) ||
        typeof node.class_type !== "string" ||
        !node.class_type ||
        node.class_type.length > 256 ||
        !plain(node.inputs)
      )
        fail();
      const inputs = cloneJSON(node.inputs);
      if (!plain(inputs)) fail();
      const clonedNode: ComfyWorkflowDefinition["graph"][string] = {
        class_type: node.class_type,
        inputs,
      };
      if (hasOwn(node, "_meta")) clonedNode._meta = cloneJSON(node._meta);
      graph[nodeId] = clonedNode;
    }
    // Comfy links are [node id, output slot]. Never accept dangling references.
    const inspectLinks = (value: JSONValue): void => {
      if (Array.isArray(value)) {
        if (
          value.length === 2 &&
          typeof value[0] === "string" &&
          typeof value[1] === "number"
        ) {
          if (
            !Number.isSafeInteger(value[1]) ||
            value[1] < 0 ||
            !hasOwn(graph, value[0])
          )
            fail();
        }
        for (const child of value) inspectLinks(child);
      } else if (value && typeof value === "object")
        for (const child of Object.values(value)) inspectLinks(child);
    };
    for (const node of Object.values(graph)) inspectLinks(node.inputs);
    if (outputsSource.length < 1 || outputsSource.length > 8) fail();
    const outputNodes: string[] = [];
    for (const out of outputsSource) {
      if (
        typeof out !== "string" ||
        !hasOwn(graph, out) ||
        outputNodes.includes(out)
      )
        fail();
      outputNodes.push(out);
    }
    const variableKeys = keys(variablesSource);
    if (variableKeys.length > 16) fail();
    const variables: Record<
      string,
      ComfyWorkflowDefinition["variables"][string]
    > = Object.create(null);
    const targets = new Set<string>();
    for (const name of variableKeys) {
      if (!SHORT_ID.test(name)) fail();
      const raw = variablesSource[name];
      if (!plain(raw)) fail();
      keys(raw);
      const { nodeId, input, type } = raw;
      if (
        typeof nodeId !== "string" ||
        !hasOwn(graph, nodeId) ||
        typeof input !== "string" ||
        !SHORT_ID.test(input) ||
        !hasOwn(graph[nodeId]!.inputs, input) ||
        (type !== "string" && type !== "integer" && type !== "enum")
      )
        fail();
      const target = `${nodeId}\0${input}`;
      if (targets.has(target)) fail();
      targets.add(target);
      let binding: ComfyWorkflowDefinition["variables"][string];
      if (type === "string") {
        if (
          keys(raw).some(
            (k) => !["nodeId", "input", "type", "maxLength"].includes(k),
          ) ||
          !Number.isInteger(raw.maxLength) ||
          (raw.maxLength as number) < 0 ||
          (raw.maxLength as number) > 8192
        )
          fail();
        binding = { nodeId, input, type, maxLength: raw.maxLength as number };
      } else if (type === "integer") {
        if (
          keys(raw).some(
            (k) =>
              !["nodeId", "input", "type", "min", "max", "step"].includes(k),
          ) ||
          !Number.isSafeInteger(raw.min) ||
          !Number.isSafeInteger(raw.max) ||
          (raw.min as number) > (raw.max as number) ||
          (hasOwn(raw, "step") &&
            (!Number.isSafeInteger(raw.step) || (raw.step as number) <= 0))
        )
          fail();
        binding = {
          nodeId,
          input,
          type,
          min: raw.min as number,
          max: raw.max as number,
        };
        if (hasOwn(raw, "step")) binding.step = raw.step as number;
      } else {
        if (
          keys(raw).some(
            (k) => !["nodeId", "input", "type", "values"].includes(k),
          ) ||
          !Array.isArray(raw.values) ||
          raw.values.length < 1 ||
          raw.values.length > 64 ||
          raw.values.some((v) => typeof v !== "string" || v.length > 128) ||
          new Set(raw.values).size !== raw.values.length
        )
          fail();
        binding = { nodeId, input, type, values: [...raw.values] as string[] };
      }
      validateValue(binding, graph[nodeId]!.inputs[input]);
      variables[name] = binding;
    }
    const definition: ComfyWorkflowDefinition = {
      id,
      graph,
      variables,
      outputNodes,
    };
    if (Buffer.byteLength(JSON.stringify(definition), "utf8") > 256 * 1024)
      fail();
    return definition;
  }

  render(
    values: Readonly<Record<string, unknown>> = {},
  ): RenderedComfyWorkflow {
    try {
      if (!plain(values)) fail();
      const supplied = keys(values);
      for (const name of supplied)
        if (!hasOwn(this.definition.variables, name)) fail();
      const graph = cloneJSON(
        this.definition.graph,
      ) as ComfyWorkflowDefinition["graph"];
      for (const name of supplied) {
        const binding = this.definition.variables[name];
        if (!binding) fail();
        graph[binding.nodeId]!.inputs[binding.input] = validateValue(
          binding,
          values[name],
        );
      }
      if (Buffer.byteLength(JSON.stringify(graph), "utf8") > 256 * 1024) fail();
      return {
        graph: graph as ComfyWorkflowDefinition["graph"],
        outputNodes: [...this.definition.outputNodes],
      };
    } catch {
      throw new Error(BAD);
    }
  }
}

export function createComfyWorkflowPolicy(
  definition: ComfyWorkflowDefinition,
): ComfyWorkflowPolicy {
  return new ComfyWorkflowPolicy(definition);
}
