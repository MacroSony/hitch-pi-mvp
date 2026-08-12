import { ApiClient, CDN_BASE_URL, loginWithQRCode } from "wechat-ilink-client";

import { writeWeChatCredentials } from "./channels/wechat-state.js";

function stateDirectory(arguments_: readonly string[]): string {
  const index = arguments_.indexOf("--state-dir");
  const value = index === -1 ? undefined : arguments_[index + 1];
  if (
    value === undefined ||
    arguments_.length !== 2 ||
    index !== 0 ||
    !value.startsWith("/")
  ) {
    throw new Error(
      "usage: hitch-wechat-login --state-dir /absolute/private/state-directory",
    );
  }
  return value;
}

async function main(): Promise<void> {
  process.umask(0o077);
  const directory = stateDirectory(process.argv.slice(2));
  const api = new ApiClient();
  const result = await loginWithQRCode(api, {
    onQRCode: (url) => {
      process.stdout.write(`Open this WeChat QR URL and confirm it:\n${url}\n`);
    },
    onStatus: (status) => {
      process.stdout.write(`WeChat login status: ${status}\n`);
    },
  });
  if (
    !result.connected ||
    result.botToken === undefined ||
    result.accountId === undefined
  ) {
    throw new Error(result.message);
  }
  writeWeChatCredentials(directory, {
    schemaVersion: 1,
    authenticatedAccountId: result.accountId,
    token: result.botToken,
    baseUrl: result.baseUrl ?? api.baseUrl,
    cdnBaseUrl: CDN_BASE_URL,
  });
  process.stdout.write(
    `WeChat login saved for account ${result.accountId} in the private state directory.\n`,
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "unknown login error";
  process.stderr.write(`WeChat login failed: ${message}\n`);
  process.exitCode = 1;
});
