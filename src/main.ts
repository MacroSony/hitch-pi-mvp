import { loadConfig } from "./config/config.js";
import { bootstrapFoundation } from "./foundation/bootstrap.js";

function configPath(arguments_: readonly string[]): string {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--config" ||
    arguments_[1] === undefined
  ) {
    throw new Error("usage: hitch-pi-mvp --config /absolute/path/config.json");
  }
  return arguments_[1];
}

function main(): void {
  process.umask(0o077);
  const config = loadConfig(configPath(process.argv.slice(2)));
  const foundation = bootstrapFoundation(config);
  try {
    const endpointCount = foundation.topology.users.reduce(
      (total, user) => total + user.endpoints.length,
      0,
    );
    process.stdout.write(
      `${JSON.stringify({
        status: "initialized",
        schemaVersion: config.schemaVersion,
        users: foundation.topology.users.length,
        endpoints: endpointCount,
      })}\n`,
    );
  } finally {
    foundation.close();
  }
}

try {
  main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "unknown startup failure";
  process.stderr.write(`hitch startup failed: ${message}\n`);
  process.exitCode = 1;
}
