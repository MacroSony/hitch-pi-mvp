import { HitchApplication } from "./app/application.js";
import { HitchStore } from "./app/store.js";
import { TelegramBotClient, TelegramWorker } from "./channels/telegram.js";
import { loadConfig, readRequiredSecret } from "./config/config.js";
import { bootstrapFoundation } from "./foundation/bootstrap.js";
import { FakeAgentRuntime } from "./runtime/runtime.js";

interface CliOptions {
  readonly configPath: string;
  readonly mode: "check" | "fake-telegram";
}

function options(arguments_: readonly string[]): CliOptions {
  const configIndex = arguments_.indexOf("--config");
  const configPath =
    configIndex === -1 ? undefined : arguments_[configIndex + 1];
  const fakeTelegram = arguments_.includes("--fake-telegram");
  const expectedLength = fakeTelegram ? 3 : 2;
  if (
    configIndex === -1 ||
    configPath === undefined ||
    arguments_.length !== expectedLength ||
    arguments_.some(
      (argument, index) =>
        index !== configIndex &&
        index !== configIndex + 1 &&
        argument !== "--fake-telegram",
    )
  ) {
    throw new Error(
      "usage: hitch-pi-mvp --config /absolute/path/config.json [--fake-telegram]",
    );
  }
  return { configPath, mode: fakeTelegram ? "fake-telegram" : "check" };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const cli = options(process.argv.slice(2));
  const config = loadConfig(cli.configPath);
  const foundation = bootstrapFoundation(config);
  try {
    const endpointCount = foundation.topology.users.reduce(
      (total, user) => total + user.endpoints.length,
      0,
    );
    if (cli.mode === "check") {
      process.stdout.write(
        `${JSON.stringify({
          status: "initialized",
          schemaVersion: config.schemaVersion,
          users: foundation.topology.users.length,
          endpoints: endpointCount,
        })}\n`,
      );
      return;
    }

    if (config.telegramAccounts.length === 0)
      throw new Error(
        "fake Telegram mode requires a configured Telegram account",
      );
    const store = new HitchStore(foundation.database);
    const application = new HitchApplication(store, new FakeAgentRuntime());
    application.start();
    const workers = config.telegramAccounts.map(
      (account) =>
        new TelegramWorker(
          account.id,
          new TelegramBotClient(readRequiredSecret(account.botTokenEnv)),
          application,
          store,
        ),
    );
    const shutdown = new AbortController();
    const stop = (): void => shutdown.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      process.stdout.write(
        `${JSON.stringify({
          status: "running",
          runtime: "fake",
          users: foundation.topology.users.length,
          telegramAccounts: workers.length,
        })}\n`,
      );
      await Promise.all(workers.map((worker) => worker.run(shutdown.signal)));
      await application.drain();
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    foundation.close();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "unknown startup failure";
  process.stderr.write(`hitch startup failed: ${message}\n`);
  process.exitCode = 1;
});
