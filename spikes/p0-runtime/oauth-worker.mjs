#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const required = [
	"HITCH_PI_PACKAGE_ROOT",
	"HITCH_AUTH_PATH",
	"HITCH_READY_LOG",
	"HITCH_START_MARKER",
	"HITCH_REFRESH_LOG",
];
for (const name of required) {
	if (!process.env[name]) throw new Error(`missing ${name}`);
}

const { ModelRuntime } = await import(
	pathToFileURL(join(process.env.HITCH_PI_PACKAGE_ROOT, "dist/index.js")).href
);

const runtime = await ModelRuntime.create({
	authPath: process.env.HITCH_AUTH_PATH,
	modelsPath: null,
	refreshOnCreate: false,
});
runtime.registerProvider("hitch-fixture-oauth", {
	name: "Hitch fixture OAuth worker",
	baseUrl: "http://127.0.0.1:9/v1",
	api: "openai-completions",
	models: [
		{
			id: "oauth-reasoning",
			name: "oauth-reasoning",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 2_048,
		},
	],
	oauth: {
		name: "Hitch fixture OAuth worker",
		async login() {
			throw new Error("fixture login is intentionally disabled");
		},
		async refreshToken(credentials, signal) {
			signal.throwIfAborted();
			appendFileSync(process.env.HITCH_REFRESH_LOG, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
			await new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, 250);
				const abort = () => {
					clearTimeout(timer);
					reject(signal.reason);
				};
				signal.addEventListener("abort", abort, { once: true });
			});
			if (process.env.HITCH_REFRESH_FAIL === "1") throw new Error("synthetic refresh failure");
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

appendFileSync(process.env.HITCH_READY_LOG, `${JSON.stringify({ pid: process.pid })}\n`);
const deadline = Date.now() + 5_000;
while (!existsSync(process.env.HITCH_START_MARKER)) {
	if (Date.now() >= deadline) throw new Error("worker start barrier timed out");
	await new Promise((resolve) => setTimeout(resolve, 5));
}

const model = runtime.getModel("hitch-fixture-oauth", "oauth-reasoning");
if (!model) throw new Error("fixture model missing");
const modelKey = `${model.provider}/${model.id}`;
try {
	const auth = await runtime.getAuth(model);
	process.stdout.write(`${JSON.stringify({ success: auth !== undefined, model: modelKey })}\n`);
} catch (error) {
	process.stdout.write(`${JSON.stringify({ success: false, model: modelKey, errorName: error instanceof Error ? error.name : "unknown" })}\n`);
}
