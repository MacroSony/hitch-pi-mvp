#!/usr/bin/env node
/**
 * P0a RPC driver — spawns `pi --mode rpc` with the given flags and drives a
 * scripted interaction: get_commands, p0a dump command, and a direct bash call.
 *
 * Usage:
 *   node p0a-driver.mjs [--tag <name>] -- <pi args...>
 *
 * Logs every JSON line received from stdout, then terminates the child.
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
let tag = "run";
const piArgs = [];
let i = 0;
while (i < argv.length) {
	if (argv[i] === "--tag") {
		tag = argv[++i];
	} else if (argv[i] === "--") {
		piArgs.push(...argv.slice(i + 1));
		break;
	} else {
		piArgs.push(argv[i]);
	}
	i++;
}

const child = spawn("pi", piArgs, {
	env: {
		...process.env,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		NO_COLOR: "1",
	},
	stdio: ["pipe", "pipe", "pipe"],
});

let stderrBuf = "";
child.stderr.on("data", (d) => {
	stderrBuf += d.toString();
});

const events = [];
child.stdout.on("data", (d) => {
	const text = d.toString();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		events.push(line.trim());
		console.log(`[${tag}][out] ${line.trim()}`);
	}
});

function send(obj) {
	const line = JSON.stringify(obj);
	console.log(`[${tag}][in]  ${line}`);
	child.stdin.write(line + "\n");
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs = 20000, what = "condition") {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const hit = events.find(predicate);
		if (hit) return hit;
		await sleep(100);
	}
	throw new Error(`timeout waiting for ${what}`);
}

async function main() {
	const ready = await waitFor(
		(e) => e.includes('"type":"session_start"') || e.includes('"type":"response"') || e.includes('"type":"agent_'),
		30000,
		"startup event",
	).catch(() => null);

	await sleep(500);

	// 1. list commands
	send({ id: "c1", type: "get_commands" });
	await waitFor((e) => e.includes('"id":"c1"'), 15000, "get_commands response").catch(() => null);

	// 2. invoke the p0a command to dump tools
	send({ id: "c2", type: "prompt", message: "/p0a" });
	await sleep(3000);

	// 3. direct bash call — exercises user_bash interception
	send({ id: "c3", type: "bash", command: "echo P0A_BASH_PROBE_OK" });
	await waitFor((e) => e.includes('"id":"c3"'), 20000, "bash response").catch(() => null);

	await sleep(2000);
	child.kill("SIGTERM");
	await sleep(800);
	if (stderrBuf) console.log(`[${tag}][stderr] ${stderrBuf.slice(0, 2000)}`);
	process.exit(0);
}

main().catch((err) => {
	console.error(`[${tag}][driver-error] ${err.message}`);
	child.kill("SIGKILL");
	process.exit(1);
});
