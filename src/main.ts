import { join } from "node:path";

import { HitchApplication } from "./app/application.js";
import { HitchStore } from "./app/store.js";
import { directFetcher } from "./channels/direct-fetch.js";
import { proxyFetcher } from "./channels/proxy-fetch.js";
import { TelegramBotClient, TelegramWorker } from "./channels/telegram.js";

// The pinned WeChat client always uses the global fetch. Route it through
// the direct HTTPS implementation: the WeChat API returns a content-length
// value that undici rejects, and its CDN downloads should not be proxied.
// Telegram gets its own explicit proxy fetch below.
globalThis.fetch = directFetcher as typeof fetch;
import { WeChatIlinkClient, WeChatWorker } from "./channels/wechat.js";
import { WeChatStateStore } from "./channels/wechat-state.js";
import { loadConfig, readRequiredSecret } from "./config/config.js";
import { bootstrapFoundation } from "./foundation/bootstrap.js";
import { createForgeCatalog } from "./forge/catalog.js";
import { NativePiRuntime } from "./pi/native-runtime.js";
import { MediaStore } from "./media/media-store.js";
import { FakeAgentRuntime, type AgentRuntime } from "./runtime/runtime.js";

interface CliOptions {
  readonly configPath: string;
  readonly mode: "check" | "fake-channels" | "channels";
}

function options(arguments_: readonly string[]): CliOptions {
  const configIndex = arguments_.indexOf("--config");
  const configPath =
    configIndex === -1 ? undefined : arguments_[configIndex + 1];
  const fakeChannels =
    arguments_.includes("--fake-channels") ||
    arguments_.includes("--fake-telegram");
  const nativeChannels =
    arguments_.includes("--channels") || arguments_.includes("--telegram");
  const expectedLength = fakeChannels || nativeChannels ? 3 : 2;
  if (
    configIndex === -1 ||
    configPath === undefined ||
    (fakeChannels && nativeChannels) ||
    arguments_.length !== expectedLength ||
    arguments_.some(
      (argument, index) =>
        index !== configIndex &&
        index !== configIndex + 1 &&
        argument !== "--fake-telegram" &&
        argument !== "--telegram" &&
        argument !== "--fake-channels" &&
        argument !== "--channels",
    )
  ) {
    throw new Error(
      "usage: hitch-pi-mvp --config /absolute/path/config.json [--channels | --fake-channels]",
    );
  }
  return {
    configPath,
    mode: fakeChannels
      ? "fake-channels"
      : nativeChannels
        ? "channels"
        : "check",
  };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const cli = options(process.argv.slice(2));
  const config = loadConfig(cli.configPath);
  const foundation = bootstrapFoundation(config);
  try {
    const forge =
      config.forge !== undefined && config.forge.enabledUsers.length > 0
        ? createForgeCatalog({
            ...config.forge,
            forbiddenRoots: [
              config.dataRoot,
              config.piProfileDir,
              ...config.users.map((user) => user.workspace),
              ...config.wechatAccounts.map((account) => account.stateDir),
            ],
          })
        : undefined;
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

    if (
      config.telegramAccounts.length === 0 &&
      config.wechatAccounts.length === 0
    ) {
      throw new Error("channel mode requires at least one configured account");
    }
    const media = new MediaStore(
      foundation.topology.dataRoot.path,
      config.minimumFreeBytes,
    );
    const telegramFetcher = proxyFetcher(
      process.env.HITCH_TELEGRAM_PROXY ??
        process.env.HTTPS_PROXY ??
        process.env.https_proxy,
    );
    const telegramClients = config.telegramAccounts.map((account) => ({
      account,
      client: new TelegramBotClient(
        readRequiredSecret(account.botTokenEnv),
        telegramFetcher,
      ),
    }));
    const wechatStates = config.wechatAccounts.map((account) => ({
      account,
      state: new WeChatStateStore(account.id, account.stateDir),
    }));
    if (
      new Set(
        wechatStates.map(
          ({ state }) => state.credentials.authenticatedAccountId,
        ),
      ).size !== wechatStates.length
    ) {
      throw new Error(
        "configured WeChat accounts must use distinct authenticated bot accounts",
      );
    }
    const nativeWebSearch =
      cli.mode === "channels" &&
      config.webSearch !== undefined &&
      config.webSearch.enabledUsers.length > 0
        ? {
            apiKey: readRequiredSecret(config.webSearch.apiKeyEnv),
            enabledUsers: config.webSearch.enabledUsers,
          }
        : undefined;
    const runtime: AgentRuntime =
      cli.mode === "fake-channels"
        ? new FakeAgentRuntime(undefined, [], forge)
        : await NativePiRuntime.create({
            dataRoot: foundation.topology.dataRoot.path,
            piProfileDir: foundation.topology.piProfileDir.path,
            userIds: foundation.topology.users.map((user) => user.id),
            maxConcurrentTurns: config.maxConcurrentTurns,
            mediaStore: media,
            antigravity: config.antigravity ?? false,
            ...(forge === undefined ? {} : { forge }),
            ...(nativeWebSearch === undefined
              ? {}
              : { webSearch: nativeWebSearch }),
          });
    const store = new HitchStore(
      foundation.database,
      undefined,
      undefined,
      (userId) => media.assertAdmissionCapacity(userId),
    );
    media.cleanupUnreferenced(store.artifactStorageKeys());
    const application = new HitchApplication(
      store,
      runtime,
      config.mediaMode,
      media,
      undefined,
      (userId) => join(foundation.topology.dataRoot.path, "users", userId),
    );
    const telegramWorkers = telegramClients.map(
      ({ account, client }) =>
        new TelegramWorker(account.id, client, application, store, media),
    );
    const wechatWorkers = wechatStates.map(({ account, state }) => {
      return new WeChatWorker(
        account.id,
        new WeChatIlinkClient(state.credentials),
        state,
        application,
        store,
        media,
      );
    });
    const workers = [...telegramWorkers, ...wechatWorkers];
    application.start();
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
          runtime: cli.mode === "fake-channels" ? "fake" : "native-pi",
          ...(runtime instanceof NativePiRuntime
            ? { catalogDigest: runtime.catalogDigest }
            : {}),
          users: foundation.topology.users.length,
          telegramAccounts: telegramWorkers.length,
          wechatAccounts: wechatWorkers.length,
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
