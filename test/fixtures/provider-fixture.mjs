import fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const SOURCE_SENTINEL = "HITCH_B2_SOURCE_SENTINEL";
const RESULT_SENTINEL = "HITCH_B2_WEB_RESULT_SENTINEL";
const MODE_A_PROMPT_SENTINEL = "HITCH_MODE_A_PROMPT_SENTINEL";
const MODE_A_SETTLED_SENTINEL = "HITCH_MODE_A_DISABLED_TOOLS_SETTLED";
const MODE_A_MUTATION_MARKER = "HITCH_MODE_A_MUTATION_HOST_EXECUTED";
const BASELINE_TOOLS = [
  "bash",
  "edit",
  "find",
  "grep",
  "hitch_publish",
  "ls",
  "read",
  "write",
];

function model(id) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 2_048,
  };
}

function assistant(selectedModel, content, stopReason) {
  return {
    role: "assistant",
    content,
    api: selectedModel.api,
    provider: selectedModel.provider,
    model: selectedModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function modeAExpectedTools() {
  try {
    const value = JSON.parse(process.env.HITCH_ACTIVE_TOOLS ?? "[]");
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? [...value].sort()
      : [];
  } catch {
    return [];
  }
}

function modeAForgePrompt() {
  try {
    const value = JSON.parse(process.env.HITCH_FORGE_PROMPT ?? "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

// This deliberately records only predicates and names. The compiled prompt itself
// must never be copied into fixture output or logs.
function modeAObservation(context, mode) {
  const prompt =
    typeof context.systemPrompt === "string" ? context.systemPrompt : "";
  const toolNames = Array.isArray(context.tools)
    ? context.tools
        .map((tool) => (tool && typeof tool.name === "string" ? tool.name : ""))
        .sort()
    : [];
  const expectedTools = modeAExpectedTools();
  const forge = modeAForgePrompt();
  const forgeText =
    typeof forge?.systemPrompt === "string" ? forge.systemPrompt : "";
  const forgeMode = forge?.mode;
  const promptHasSentinel = prompt.includes(MODE_A_PROMPT_SENTINEL);
  const defaultPromptMarker =
    "You are an expert coding assistant operating inside pi";
  const defaultPromptPresent = prompt.includes(defaultPromptMarker);
  const toolNamesExact =
    JSON.stringify(toolNames) === JSON.stringify(expectedTools);
  const promptShape =
    forgeMode === "replace" && prompt === forgeText
      ? "replace"
      : forgeMode === "append" && prompt.endsWith(forgeText)
        ? "append"
        : forgeMode === "prepend" && prompt.startsWith(forgeText)
          ? "prepend"
          : "invalid";
  const defaultIndex = prompt.indexOf(defaultPromptMarker);
  const forgeIndex = forgeText.length > 0 ? prompt.indexOf(forgeText) : -1;
  const promptOrder =
    forgeMode === "append"
      ? defaultPromptPresent && forgeIndex > defaultIndex
        ? "default-before-forge"
        : "invalid"
      : forgeMode === "prepend"
        ? defaultPromptPresent && forgeIndex >= 0 && forgeIndex < defaultIndex
          ? "forge-before-default"
          : "invalid"
        : forgeMode === "replace" && prompt === forgeText
          ? "replace"
          : "invalid";
  const valid =
    mode === "mode-a-empty"
      ? forgeText.trim().length === 0 && defaultPromptPresent && toolNamesExact
      : promptHasSentinel && toolNamesExact && promptOrder !== "invalid";
  const observation = {
    mode,
    promptHasSentinel,
    defaultPromptPresent,
    toolNamesExact,
    toolNames,
    promptShape,
    promptOrder,
    promptIsExactForge: forgeMode === "replace" && prompt === forgeText,
    promptStartsWithForge: forgeText.length > 0 && prompt.startsWith(forgeText),
    promptEndsWithForge: forgeText.length > 0 && prompt.endsWith(forgeText),
    valid,
  };
  if (process.env.HITCH_B2_PROVIDER_LOG) {
    fs.appendFileSync(
      process.env.HITCH_B2_PROVIDER_LOG,
      `${JSON.stringify(observation)}\n`,
    );
  }
  return observation;
}

function streamFixture(selectedModel, context, options) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const toolResults = context.messages.filter(
      (message) => message.role === "toolResult",
    );
    const mode = process.env.HITCH_B2_PROVIDER_MODE ?? "web-search";
    let content;
    let stopReason;

    if (mode === "unknown-web") {
      if (toolResults.length === 0) {
        content = [
          {
            type: "toolCall",
            id: "hitch-b2-unknown",
            name: "web_search",
            arguments: { query: "must-not-run" },
          },
        ];
        stopReason = "toolUse";
      } else {
        content = [{ type: "text", text: "HITCH_B2_DISABLED_UNKNOWN_TOOL" }];
        stopReason = "stop";
      }
    } else if (mode === "mode-a-disabled-tools") {
      modeAObservation(context, mode);
      if (toolResults.length === 0) {
        content = [
          {
            type: "toolCall",
            id: "hitch-mode-a-web-disabled",
            name: "web_search",
            arguments: { query: "must-not-reach-fixture" },
          },
        ];
        stopReason = "toolUse";
      } else if (toolResults.length === 1) {
        content = [
          {
            type: "toolCall",
            id: "hitch-mode-a-bash-disabled",
            name: "bash",
            arguments: {
              command: `touch ${MODE_A_MUTATION_MARKER}`,
            },
          },
        ];
        stopReason = "toolUse";
      } else {
        content = [{ type: "text", text: MODE_A_SETTLED_SENTINEL }];
        stopReason = "stop";
      }
    } else if (mode === "mode-a-mutation" || mode === "mode-a-rpc-bash") {
      modeAObservation(context, mode);
      if (toolResults.length === 0) {
        content = [
          {
            type: "toolCall",
            id: `hitch-${mode}-bash`,
            name: "bash",
            arguments: { command: `touch ${MODE_A_MUTATION_MARKER}` },
          },
        ];
        stopReason = "toolUse";
      } else {
        content = [{ type: "text", text: MODE_A_SETTLED_SENTINEL }];
        stopReason = "stop";
      }
    } else if (mode.startsWith("mode-a")) {
      const observation = modeAObservation(context, mode);
      content = [
        {
          type: "text",
          text: observation.valid
            ? "HITCH_MODE_A_PROMPT_PROVIDER_SENTINEL"
            : "HITCH_MODE_A_PROMPT_PROVIDER_MISMATCH",
        },
      ];
      stopReason = "stop";
    } else if (toolResults.length === 0) {
      content = [
        {
          type: "toolCall",
          id: "hitch-b2-web",
          name: "web_search",
          arguments: { query: "fixture query", limit: 1 },
        },
      ];
      stopReason = "toolUse";
    } else {
      const last = toolResults.at(-1);
      const observed = JSON.stringify(last);
      const text = observed.includes(SOURCE_SENTINEL)
        ? RESULT_SENTINEL
        : "HITCH_B2_WEB_RESULT_NOT_OBSERVED";
      content = [{ type: "text", text }];
      stopReason = "stop";
    }

    if (process.env.HITCH_B2_PROVIDER_LOG && !mode.startsWith("mode-a")) {
      fs.appendFileSync(
        process.env.HITCH_B2_PROVIDER_LOG,
        `${JSON.stringify({
          mode,
          toolResultCount: toolResults.length,
          observedSentinel:
            toolResults.length > 0 &&
            JSON.stringify(toolResults.at(-1)).includes(SOURCE_SENTINEL),
        })}\n`,
      );
    }
    const aborted = options?.signal?.aborted === true;
    const message = assistant(
      selectedModel,
      aborted ? [] : content,
      aborted ? "aborted" : stopReason,
    );
    stream.push({ type: "start", partial: message });
    if (aborted)
      stream.push({ type: "error", reason: "aborted", error: message });
    else stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

export default function (pi) {
  const mode = process.env.HITCH_B2_PROVIDER_MODE ?? "web-search";
  if (mode === "mode-a-mutation") {
    const baseline = [...BASELINE_TOOLS];
    if (process.env.HITCH_WEB_SEARCH_ENABLED === "1")
      baseline.push("web_search");
    const restoreBaseline = () => pi.setActiveTools(baseline.sort());
    // These run after Hitch's startup setup because this fixture is loaded after
    // the mandatory extension. They intentionally test the execute-time gate.
    pi.on("session_start", async () => restoreBaseline());
    pi.on("before_agent_start", async () => restoreBaseline());
  }
  pi.registerProvider("hitch-b2-fixture", {
    name: "Hitch B2 deterministic provider fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "B2_PROVIDER_ONLY_NOT_A_WEB_KEY",
    api: "openai-completions",
    streamSimple: streamFixture,
    models: [model("b2-web-search")],
  });
}
