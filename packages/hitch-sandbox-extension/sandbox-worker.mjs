#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_PUBLISH_BYTES = 50 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
	throw new Error(message);
}

async function readRequest() {
	const chunks = [];
	let used = 0;
	for await (const chunk of process.stdin) {
		used += chunk.length;
		if (used > MAX_REQUEST_BYTES) fail("request-too-large");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	if (bytes.length === 0) fail("request-missing");
	return JSON.parse(decoder.decode(bytes));
}

function strictRelative(value, allowDot = false) {
	if (
		typeof value !== "string" || value.length === 0 || value.length > 4096 ||
		value.startsWith("/") || value.endsWith("/") || /[\u0000-\u001f\u007f]/u.test(value)
	) fail("invalid-path");
	if (allowDot && value === ".") return value;
	if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
		fail("invalid-path");
	}
	return value;
}

function readablePath(value, allowDot = false) {
	if (typeof value === "string" && value.startsWith("/inbox/")) {
		return join("/inbox", strictRelative(value.slice("/inbox/".length), allowDot));
	}
	return join("/workspace", strictRelative(value ?? ".", allowDot));
}

function workspacePath(value) {
	return join("/workspace", strictRelative(value));
}

function boundedUtf8(path, maximum = MAX_FILE_BYTES) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > maximum) fail("file-invalid");
	return decoder.decode(readFileSync(path));
}

function prefixUtf8(value, maximum = MAX_OUTPUT_BYTES) {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximum) return value;
	return decoder.decode(bytes.subarray(0, maximum - 32)) + "\n[output-truncated]";
}

function listTree(root, predicate, limit = MAX_ENTRIES) {
	const output = [];
	function visit(directory) {
		for (const name of readdirSync(directory).sort()) {
			if (output.length >= limit) return;
			const absolute = join(directory, name);
			const stat = lstatSync(absolute);
			if (stat.isSymbolicLink()) continue;
			const item = relative(root, absolute).split(sep).join(posix.sep);
			if (predicate(absolute, item, stat)) output.push(item);
			if (stat.isDirectory()) visit(absolute);
		}
	}
	visit(root);
	return output;
}

async function bash(command, timeoutMs) {
	if (typeof command !== "string" || command.length === 0 || command.length > 65536) {
		fail("invalid-command");
	}
	const timeout = Math.max(100, Math.min(Number(timeoutMs) || 5000, 5000));
	return new Promise((resolveResult, reject) => {
		const child = spawn("/bin/bash", ["-lc", command], {
			cwd: "/workspace",
			env: { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks = [];
		let used = 0;
		let exceeded = false;
		const collect = (chunk) => {
			used += chunk.length;
			if (used > MAX_OUTPUT_BYTES) {
				exceeded = true;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", reject);
		const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (exceeded) return reject(new Error("output-limit"));
			resolveResult({
				output: Buffer.concat(chunks).toString("utf8"),
				exitCode: code ?? (signal ? 128 : 1),
			});
		});
	});
}

async function publish(input) {
	if (!statSync("/publish").isDirectory()) fail("publication-bridge-unavailable");
	const sourcePath = strictRelative(input.path);
	if (typeof input.artifactId !== "string" || !/^[a-f0-9]{32}$/.test(input.artifactId)) {
		fail("invalid-artifact-handle");
	}
	return new Promise((resolveResult, reject) => {
		const child = spawn(
			"/hitch-runtime/publish-copy",
			["--publish-copy", sourcePath, input.artifactId],
			{ env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		const chunks = [];
		let used = 0;
		let settled = false;
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error); else resolveResult(result);
		};
		const collect = (chunk) => {
			used += chunk.length;
			if (used > 4096) {
				child.kill("SIGKILL");
				finish(new Error("publication-response-too-large"));
				return;
			}
			chunks.push(chunk);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", () => finish(new Error("publication-helper-failed")));
		child.once("close", (code, signal) => {
			if (code !== 0 || signal !== null) return finish(new Error("publication-helper-failed"));
			try {
				const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (
					result?.artifactId !== input.artifactId || !Number.isSafeInteger(result.bytes) ||
					result.bytes < 0 || result.bytes > MAX_PUBLISH_BYTES ||
					typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256)
				) fail("publication-helper-response-invalid");
				// Extension hint via blob filename: the runtime re-validates the
				// segment against its own allowlist, so this only ever travels as
				// an untrusted hint in a name we control.
				const extension = /\.([A-Za-z0-9]{1,8})$/.exec(sourcePath)?.[1]?.toLowerCase();
				if (extension !== undefined) {
					try {
						renameSync(
							`/publish/${input.artifactId}.blob`,
							`/publish/${input.artifactId}.${extension}.blob`,
						);
					} catch { finish(new Error("publication-rename-failed")); return; }
				}
				finish(null, result);
			} catch { finish(new Error("publication-helper-response-invalid")); }
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error("publication-helper-timeout"));
		}, 5000);
	});
}

async function execute(request) {
	if (request === null || typeof request !== "object" || Array.isArray(request)) fail("invalid-request");
	const input = request.input ?? {};
	switch (request.operation) {
		case "probe": {
			const network = await bash("/usr/bin/timeout 1 /usr/bin/bash -c '</dev/tcp/1.1.1.1/53'", 1500);
			return {
				cwd: process.cwd(),
				environmentKeys: Object.keys(process.env).sort(),
				hostHomeVisible: statSafe("/home"),
				networkNamespaceHasExternalInterface: statSafe("/sys/class/net/eth0"),
				networkDenied: network.exitCode !== 0,
				inboxWritable: writeDenied("/inbox/should-not-write"),
				publishVisible: statSafe("/publish"),
			};
		}
		case "read": {
			const text = boundedUtf8(readablePath(input.path));
			const lines = text.split("\n");
			const offset = Math.max(1, Number(input.offset) || 1);
			const limit = Math.max(1, Math.min(Number(input.limit) || 2000, 2000));
			return { text: prefixUtf8(lines.slice(offset - 1, offset - 1 + limit).join("\n")) };
		}
		case "write": {
			if (typeof input.content !== "string" || Buffer.byteLength(input.content) > MAX_FILE_BYTES) fail("write-too-large");
			const path = workspacePath(input.path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, input.content, { encoding: "utf8", mode: 0o600 });
			return { text: `wrote ${Buffer.byteLength(input.content)} bytes` };
		}
		case "edit": {
			let text = boundedUtf8(workspacePath(input.path));
			if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 64) fail("invalid-edits");
			for (const edit of input.edits) {
				if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" || edit.oldText.length === 0) fail("invalid-edit");
				const first = text.indexOf(edit.oldText);
				if (first < 0 || text.indexOf(edit.oldText, first + edit.oldText.length) >= 0) fail("edit-match-not-unique");
				text = text.slice(0, first) + edit.newText + text.slice(first + edit.oldText.length);
			}
			if (Buffer.byteLength(text) > MAX_FILE_BYTES) fail("edit-too-large");
			writeFileSync(workspacePath(input.path), text, { encoding: "utf8", mode: 0o600 });
			return { text: "edited file" };
		}
		case "ls": {
			const path = readablePath(input.path ?? ".", true);
			const entries = readdirSync(path).sort().slice(0, Math.min(Number(input.limit) || MAX_ENTRIES, MAX_ENTRIES));
			return { text: entries.join("\n") };
		}
		case "grep": {
			if (typeof input.pattern !== "string" || input.pattern.length === 0 || input.pattern.length > 4096) fail("invalid-pattern");
			const root = readablePath(input.path ?? ".", true);
			const needle = input.ignoreCase ? input.pattern.toLowerCase() : input.pattern;
			const matches = [];
			for (const item of listTree(root, (_absolute, _item, stat) => stat.isFile())) {
				let text;
				try { text = boundedUtf8(join(root, item), 1024 * 1024); } catch { continue; }
				for (const [index, line] of text.split("\n").entries()) {
					const candidate = input.ignoreCase ? line.toLowerCase() : line;
					if (candidate.includes(needle)) matches.push(`${item}:${index + 1}:${line}`);
					if (matches.length >= Math.min(Number(input.limit) || 100, 500)) break;
				}
				if (matches.length >= Math.min(Number(input.limit) || 100, 500)) break;
			}
			return { text: prefixUtf8(matches.join("\n")) };
		}
		case "find": {
			if (typeof input.pattern !== "string" || input.pattern.length === 0 || input.pattern.length > 4096) fail("invalid-pattern");
			const root = readablePath(input.path ?? ".", true);
			const pattern = input.pattern.replaceAll("**/", "").replaceAll("*", "");
			const items = listTree(root, (_absolute, item) => pattern.length === 0 || item.includes(pattern), Math.min(Number(input.limit) || MAX_ENTRIES, MAX_ENTRIES));
			return { text: items.join("\n") };
		}
		case "bash": return bash(input.command, input.timeoutMs);
		case "hitch_publish": return publish(input);
		default: fail("unknown-operation");
	}
}

function statSafe(path) {
	try { lstatSync(path); return true; } catch { return false; }
}

function writeDenied(path) {
	try { writeFileSync(path, "denied"); return false; } catch { return true; }
}

try {
	const result = await execute(await readRequest());
	const encoded = JSON.stringify({ ok: true, result });
	if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) fail("response-too-large");
	process.stdout.write(`${encoded}\n`);
} catch (error) {
	const category = error instanceof SyntaxError ? "invalid-request" : "sandbox-operation-failed";
	process.stdout.write(`${JSON.stringify({ ok: false, error: category })}\n`);
	process.exitCode = 2;
}
