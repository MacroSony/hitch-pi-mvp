import { HitchApplication } from "./app/application.js";
import { HitchStore } from "./app/store.js";
import { TelegramBotClient, TelegramWorker } from "./channels/telegram.js";
import { loadConfig, readRequiredSecret } from "./config/config.js";
import { bootstrapFoundation } from "./foundation/bootstrap.js";
import { NativePiRuntime } from "./pi/native-runtime.js";
import { MediaStore } from "./media/media-store.js";
import { FakeAgentRuntime, type AgentRuntime } from "./runtime/runtime.js";

interface CliOptions {
  readonly configPath: string;
  readonly mode: "check" | "fake-telegram" | "telegram";
}

function options(arguments_: readonly string[]): CliOptions {
  const configIndex = arguments_.indexOf("--config");
  const configPath =
    configIndex === -1 ? undefined : arguments_[configIndex + 1];
  const fakeTelegram = arguments_.includes("--fake-telegram");
  const nativeTelegram = arguments_.includes("--telegram");
  const expectedLength = fakeTelegram || nativeTelegram ? 3 : 2;
  if (
    configIndex === -1 ||
    configPath === undefined ||
    (fakeTelegram && nativeTelegram) ||
    arguments_.length !== expectedLength ||
    arguments_.some(
      (argument, index) =>
        index !== configIndex &&
        index !== configIndex + 1 &&
        argument !== "--fake-telegram" &&
        argument !== "--telegram",
    )
  ) {
    throw new Error(
      "usage: hitch-pi-mvp --config /absolute/path/config.json [--telegram | --fake-telegram]",
    );
  }
  return {
    configPath,
    mode: fakeTelegram
      ? "fake-telegram"
      : nativeTelegram
        ? "telegram"
        : "check",
  };
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
      throw new Error("Telegram mode requires a configured Telegram account");
    const media = new MediaStore(
      foundation.topology.dataRoot.path,
      config.minimumFreeBytes,
    );
    const runtime: AgentRuntime =
      cli.mode === "fake-telegram"
        ? new FakeAgentRuntime()
        : await NativePiRuntime.create({
            dataRoot: foundation.topology.dataRoot.path,
            piProfileDir: foundation.topology.piProfileDir.path,
            mediaStore: media,
          });
    const store = new HitchStore(
      foundation.database,
      undefined,
      undefined,
      (userId) => media.assertAdmissionCapacity(userId),
    );
    media.cleanupUnreferenced(store.artifactStorageKeys());
    const application = new HitchApplication(store, runtime);
    application.start();
    const workers = config.telegramAccounts.map(
      (account) =>
        new TelegramWorker(
          account.id,
          new TelegramBotClient(readRequiredSecret(account.botTokenEnv)),
          application,
          store,
          media,
        ),
    );
    const shutdown = new AbortController();
    const stop = (): void => {
      shutdown.abort();
      application.stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      process.stdout.write(
        `${JSON.stringify({
          status: "running",
          runtime: cli.mode === "fake-telegram" ? "fake" : "native-pi",
          ...(runtime instanceof NativePiRuntime
            ? { catalogDigest: runtime.catalogDigest }
            : {}),
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
