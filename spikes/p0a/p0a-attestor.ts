/**
 * Tool-free P0a extension used to attest the tool registry in discovery cases.
 * It intentionally registers no commands or tools.
 */
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG_PATH = process.env.P0A_ATTEST_LOG ?? "/tmp/p0a-attestor.log";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const api = pi as unknown as {
			getActiveTools: () => string[];
			getAllTools: () => Array<{ name: string; sourceInfo?: { source?: string } }>;
		};
		const allTools = api.getAllTools()
			.map((tool) => ({ name: tool.name, source: tool.sourceInfo?.source ?? "?" }))
			.sort((left, right) => left.name.localeCompare(right.name));
		const activeTools = api.getActiveTools().slice().sort();
		fs.appendFileSync(
			LOG_PATH,
			`${JSON.stringify({ allTools, activeTools })}\n`,
		);
	});
}
