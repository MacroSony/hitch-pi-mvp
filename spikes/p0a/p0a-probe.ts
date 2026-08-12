/**
 * P0a probe extension — proves Pi 0.84.1 extension/tool-replacement semantics.
 *
 * Registers same-name replacements for all 7 built-in file/shell tools and
 * intercepts direct user/RPC bash via the `user_bash` event. Every execution
 * writes a log line so the test harness can prove the *extension* executed,
 * not a built-in.
 *
 * This is a SEMANTIC probe only. It executes locally (createLocalBashOperations)
 * on purpose; sandbox routing is Phase 0b. Do not use in production.
 */
import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLocalBashOperations,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";

const LOG_PATH = process.env.P0A_LOG ?? "/tmp/p0a-probe.log";

function log(line: string): void {
	try {
		fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// never let logging break the probe
	}
}

function dumpTools(pi: ExtensionAPI, _ctx: ExtensionContext, tag: string): void {
	// getActiveTools/getAllTools live on ExtensionAPI, not ExtensionContext.
	const api = pi as unknown as {
		getActiveTools?: () => string[];
		getAllTools?: () => Array<{ name: string; sourceInfo?: { source?: string; path?: string } }>;
	};
	const active = api.getActiveTools?.() ?? [];
	log(`[${tag}] getActiveTools=${JSON.stringify(active)}`);
	try {
		const all = api.getAllTools?.() ?? [];
		for (const info of all) {
			log(
				`[${tag}] tool:${info.name} source=${info.sourceInfo?.source ?? "?"} path=${JSON.stringify(info.sourceInfo?.path ?? "?")}`,
			);
		}
	} catch (error) {
		log(`[${tag}] getAllTools threw: ${String(error)}`);
	}
}

export default function (pi: ExtensionAPI): void {
	log("=== extension evaluated ===");
	log(`cwd=${process.cwd()} pid=${process.pid}`);

	pi.registerCommand("p0a", {
		description: "P0a probe: dump active/all tools with source metadata",
		handler: async (_args, ctx) => {
			log("[cmd:p0a] invoked");
			dumpTools(pi, ctx, "cmd:p0a");
			const api = pi as unknown as { getActiveTools?: () => string[] };
			ctx.ui.notify(`p0a probe: ${api.getActiveTools?.().join(",") ?? "n/a"}`, "info");
		},
	});

	// Register same-name replacements for the 7 built-in tools.
	// P0A_SKIP_TOOLS="write,bash" disables registration for those names to probe
	// fail-open behavior (does the built-in come back?)
	const skipTools = new Set((process.env.P0A_SKIP_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
	const cwd = process.cwd();
	const builtins = {
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
		edit: createEditTool(cwd),
		bash: createBashTool(cwd),
		ls: createLsTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
	} as const;

	for (const [name, tool] of Object.entries(builtins)) {
		if (skipTools.has(name)) {
			log(`SKIPPED registering tool:${name}`);
			continue;
		}
		pi.registerTool({
			...tool,
			async execute(id, params, signal, onUpdate, ctx) {
				log(`[tool:${name}] execute params=${JSON.stringify(params).slice(0, 300)}`);
				return tool.execute(id, params, signal, onUpdate);
			},
		});
		log(`registered tool:${name}`);
	}

	// Intercept direct user/RPC bash. Returning operations proves the extension
	// owns the execution path; the harness checks the log line.
	pi.on("user_bash", async (event) => {
		log(
			`[user_bash] event command=${JSON.stringify(event.command)} cwd=${event.cwd} excludeFromContext=${event.excludeFromContext}`,
		);
		// P0A_BASH_OVERRIDE=1: return a fixed result to prove the extension fully
		// owns RPC bash execution (output would differ from the real command).
		if (process.env.P0A_BASH_OVERRIDE === "1") {
			return { result: { output: "P0A_EXTENSION_OWNED_BASH\n", exitCode: 0 } };
		}
		return { operations: createLocalBashOperations() };
	});

	pi.on("session_start", async () => log("[session_start]"));
	pi.on("session_shutdown", async () => log("[session_shutdown]"));
}
