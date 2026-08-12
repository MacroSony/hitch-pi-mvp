/** Credential-free local provider used only by the Phase 0 sandbox probe. */
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

const sequence = [
	{ name: "write", arguments: { path: "result.txt", content: "alpha fixture\n" } },
	{ name: "read", arguments: { path: "/inbox/input.txt" } },
	{ name: "edit", arguments: { path: "result.txt", edits: [{ oldText: "alpha", newText: "beta" }] } },
	{ name: "ls", arguments: { path: "." } },
	{ name: "grep", arguments: { pattern: "beta", path: ".", literal: true } },
	{ name: "find", arguments: { pattern: "result.txt", path: "." } },
	{
		name: "bash",
		arguments: {
			command: "/usr/bin/node -e 'const f=require(\"node:fs\");let inboxWriteDenied=false;try{f.writeFileSync(\"/inbox/nope\",\"x\")}catch{inboxWriteDenied=true}const ok=!f.existsSync(\"/home\")&&!f.existsSync(\"/profile\")&&!f.existsSync(\"/publish\")&&!process.env.HITCH_P0_CONTROLLER_SECRET&&!process.env.HITCH_P0_CHANNEL_SECRET&&!process.env.HITCH_P0_SYNTHETIC_PROVIDER_KEY&&f.readFileSync(\"/inbox/input.txt\",\"utf8\").trim()===\"inbox fixture\"&&inboxWriteDenied;f.writeFileSync(\"/workspace/bash.txt\",\"sandboxed\");process.stdout.write(ok?\"HITCH_BASH_OK\\n\":\"HITCH_BASH_BAD\\n\")'",
			timeout: 5,
		},
	},
	{ name: "hitch_publish", arguments: { path: "result.txt" } },
] as const;

function model(id: string) {
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

function streamFixture(
	selectedModel: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const toolResults = context.messages.filter((message) => message.role === "toolResult");
		const imageSeen = context.messages.some((message) =>
			message.role === "user" && Array.isArray(message.content) &&
			message.content.some((part) => part.type === "image"),
		);
		const mode = process.env.HITCH_P0_PROVIDER_MODE ?? "sequence";
		let toolCall: { name: string; arguments: Record<string, unknown> } | undefined;
		if (mode === "cancel" && toolResults.length === 0) {
			toolCall = {
				name: "bash",
				arguments: { command: "sleep 30 & child=$!; wait $child", timeout: 5 },
			};
		} else if (mode === "sequence" && toolResults.length < sequence.length) {
			toolCall = sequence[toolResults.length] as unknown as { name: string; arguments: Record<string, unknown> };
		}
		if (process.env.HITCH_P0_PROVIDER_LOG) {
			fs.appendFileSync(process.env.HITCH_P0_PROVIDER_LOG, `${JSON.stringify({
				model: `${selectedModel.provider}/${selectedModel.id}`,
				mode,
				toolResultCount: toolResults.length,
				imageSeen,
				nextTool: toolCall?.name ?? null,
			})}\n`);
		}
		const aborted = options?.signal?.aborted === true;
		const content: AssistantMessage["content"] = aborted
			? []
			: toolCall
				? [{ type: "toolCall", id: `hitch-p0-${toolResults.length}`, name: toolCall.name, arguments: toolCall.arguments }]
				: [{ type: "text", text: "HITCH_P0_SANDBOX_COMPLETE" }];
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
			stopReason: aborted ? "aborted" : toolCall ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: output });
		if (aborted) stream.push({ type: "error", reason: "aborted", error: output });
		else stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message: output });
		stream.end();
	});
	return stream;
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("hitch-p0-sandbox", {
		name: "Hitch Phase 0 sandbox fixture",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "P0_PROVIDER_SECRET_VALUE",
		api: "openai-completions",
		streamSimple: streamFixture,
		models: [model("sandbox-image")],
	});
}
