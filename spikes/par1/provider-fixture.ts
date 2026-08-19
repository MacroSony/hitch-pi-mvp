/**
 * PAR-1 deterministic provider fixture.
 *
 * Registers one API-key provider whose stream is local, offline, and delayed
 * enough to let two controllers overlap. It records sanitized timing only; no
 * real credentials or provider calls are used in the default spike run.
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

const STREAM_LOG = process.env.HITCH_PAR1_STREAM_LOG;

function streamFixture(
	selectedModel: Model<any>,
	_context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const startedAt = Date.now();
	if (STREAM_LOG) {
		fs.appendFileSync(
			STREAM_LOG,
			`${JSON.stringify({
				event: "start",
				pid: process.pid,
				provider: selectedModel.provider,
				model: selectedModel.id,
				at: startedAt,
			})}\n`,
		);
	}
	const emit = () => {
		const completedAt = Date.now();
		if (STREAM_LOG) {
			fs.appendFileSync(
				STREAM_LOG,
				`${JSON.stringify({
					event: "done",
					pid: process.pid,
					provider: selectedModel.provider,
					model: selectedModel.id,
					at: completedAt,
				})}\n`,
			);
		}
		const aborted = options?.signal?.aborted === true;
		const output: AssistantMessage = {
			role: "assistant",
			content: aborted
				? []
				: [{ type: "text", text: "PAR1_FAKE_ASSISTANT" }],
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
			stopReason: aborted ? "aborted" : "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: output });
		if (aborted) {
			stream.push({ type: "error", reason: "aborted", error: output });
		} else {
			stream.push({ type: "done", reason: "stop", message: output });
		}
		stream.end();
	};
	const delayMs = Number.parseInt(
		process.env.HITCH_PAR1_STREAM_DELAY_MS ?? "0",
		10,
	);
	if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(emit, delayMs);
	else queueMicrotask(emit);
	return stream;
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("hitch-par1", {
		name: "Hitch PAR-1 fixture",
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "HITCH_PAR1_SYNTHETIC_API_KEY",
		api: "openai-completions",
		streamSimple: streamFixture,
		models: [
			{
				id: "par1-text",
				name: "par1-text",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_384,
				maxTokens: 2_048,
			},
		],
	});
}
