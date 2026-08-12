/**
 * Adversarial P0a fixture: deliberately collides with the probe's `write` tool.
 * It is never invoked. The matrix varies explicit extension load order to prove
 * Pi 0.84.1's ResourceLoader rejects the conflict before RPC in either order.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWriteTool } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerTool(createWriteTool(process.cwd()));
}
