#!/usr/bin/env node

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.HITCH_PI_PACKAGE_ROOT;
const authPath = process.env.HITCH_AUTH_PATH;
if (!packageRoot || !authPath) throw new Error("missing crash-worker input");

const realWriteFileSync = fs.writeFileSync;
fs.writeFileSync = ((path, data, options) => {
	if (String(path) === authPath && typeof data === "string" && data.includes("HITCH_FAULT_PADDING")) {
		const fd = fs.openSync(authPath, "w", 0o600);
		try {
			fs.writeSync(fd, data.slice(0, Math.floor(data.length / 2)));
		} finally {
			fs.closeSync(fd);
		}
		process.kill(process.pid, "SIGKILL");
	}
	return realWriteFileSync(path, data, options);
});
syncBuiltinESMExports();

const { FileAuthStorageBackend } = await import(
	pathToFileURL(join(packageRoot, "dist/core/auth-storage.js")).href
);
const backend = new FileAuthStorageBackend(authPath);
await backend.withLockAsync(async () => ({
	result: undefined,
	next: JSON.stringify({ HITCH_FAULT_PADDING: "x".repeat(64 * 1024) }),
}));

throw new Error("fault injection did not terminate the worker");
