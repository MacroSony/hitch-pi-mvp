/**
 * Deterministic Phase 0 runtime fixture. It registers one API-key provider and
 * one OAuth provider without making provider calls. Values are synthetic.
 */
import fs from "node:fs";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STREAM_LOG = process.env.HITCH_FIXTURE_STREAM_LOG;
let retryInjected = false;

function model(id: string, reasoning: boolean, input: Array<"text" | "image"> = ["text"]) {
	return {
		id,
		name: id,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 2_048,
	};
}

function streamFixture(
	selectedModel: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const emit = () => {
		const aborted = options?.signal?.aborted === true;
		const hasFixtureToolResult = context.messages.some(
			(message) => message.role === "toolResult" && message.toolName === "hitch_fixture_tool",
		);
		if (STREAM_LOG) {
			fs.appendFileSync(
				STREAM_LOG,
				`${JSON.stringify({ pid: process.pid, model: `${selectedModel.provider}/${selectedModel.id}`, hasFixtureToolResult })}\n`,
			);
		}
		const injectRetry =
			!aborted && process.env.HITCH_FIXTURE_RETRY_ONCE === "1" && !retryInjected;
		if (injectRetry) retryInjected = true;
		const useTool =
			!aborted &&
			!injectRetry &&
			process.env.HITCH_FIXTURE_TOOL_LOOP === "1" &&
			selectedModel.id === "reasoning-image" &&
			!hasFixtureToolResult;
		const stopReason = aborted ? "aborted" : injectRetry ? "error" : useTool ? "toolUse" : "stop";
		const content: AssistantMessage["content"] = aborted || injectRetry
			? []
			: useTool
				? [{ type: "toolCall", id: "hitch-fixture-tool-call", name: "hitch_fixture_tool", arguments: {} }]
				: [{ type: "text", text: "HITCH_FIXTURE_ASSISTANT" }];
		const output: AssistantMessage = {
			role: "assistant",
			content,
			api: selectedModel.api,
			provider: selectedModel.provider,
			model: selectedModel.id,
			usage: {
				input: 1,
				output: aborted ? 0 : 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: aborted ? 1 : 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			...(injectRetry ? { errorMessage: "503 synthetic server error" } : {}),
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: output });
		if (aborted || injectRetry) {
			stream.push({ type: "error", reason: stopReason as "aborted" | "error", error: output });
		} else {
			stream.push({ type: "done", reason: stopReason as "stop" | "toolUse", message: output });
		}
		stream.end();
	};
	const delayMs = Number.parseInt(process.env.HITCH_FIXTURE_STREAM_DELAY_MS ?? "0", 10);
	if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(emit, delayMs);
	else queueMicrotask(emit);
	return stream;
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "hitch_fixture_tool",
		label: "Hitch fixture tool",
		description: "Deterministic no-authority tool-loop fixture",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: "HITCH_FIXTURE_TOOL_RESULT" }],
				details: {},
			};
		},
	});

	pi.registerProvider("hitch-fixture-key", {
		name: "Hitch fixture API key",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "HITCH_SYNTHETIC_API_KEY",
		api: "openai-completions",
		streamSimple: streamFixture,
		models: [
			model("plain-text", false),
			model("reasoning-image", true, ["text", "image"]),
		],
	});

	pi.registerProvider("hitch-fixture-oauth", {
		name: "Hitch fixture OAuth",
		baseUrl: "http://127.0.0.1:9/v1",
		api: "openai-completions",
		streamSimple: streamFixture,
		models: [model("oauth-reasoning", true)],
		oauth: {
			name: "Hitch fixture OAuth",
			async login() {
				throw new Error("fixture login is intentionally disabled");
			},
			async refreshToken(credentials, signal) {
				signal.throwIfAborted();
				return {
					refresh: `${credentials.refresh}-rotated`,
					access: "HITCH_SYNTHETIC_OAUTH_ACCESS_REFRESHED",
					expires: Date.now() + 60 * 60 * 1000,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		},
	});
}
