import fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const SOURCE_SENTINEL = "HITCH_B2_SOURCE_SENTINEL";
const RESULT_SENTINEL = "HITCH_B2_WEB_RESULT_SENTINEL";

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
    if (process.env.HITCH_B2_PROVIDER_LOG) {
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
  pi.registerProvider("hitch-b2-fixture", {
    name: "Hitch B2 deterministic provider fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "B2_PROVIDER_ONLY_NOT_A_WEB_KEY",
    api: "openai-completions",
    streamSimple: streamFixture,
    models: [model("b2-web-search")],
  });
}
