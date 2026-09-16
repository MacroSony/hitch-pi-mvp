import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAntigravity from "pi-agy";

type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

// Fixed public-entry adapter, not a general extension loader. The pinned root
// creates an in-memory primary pool. Its account discovery/writers only become
// reachable through the hooks/commands deliberately NOT forwarded here.
export default function (pi: ExtensionAPI): void {
  const fail = (): never => {
    throw new Error("antigravity-provider-failed");
  };
  const require = createRequire(import.meta.url);
  const self = fileURLToPath(import.meta.url);
  if (
    process.env.HITCH_ANTIGRAVITY_ENABLED !== "1" ||
    process.env.HITCH_SHARED_AUTH_INSTALLED !== "1" ||
    process.env.ANTIGRAVITY_NO_PREWARM !== "1" ||
    process.env.DEBUG_DUMP !== undefined ||
    process.env.ANTIGRAVITY_DEBUG_DUMP !== undefined ||
    process.env.NOAGY_DEBUG_DUMP !== undefined ||
    process.env.HITCH_ANTIGRAVITY_EXTENSION_PATH !== self ||
    createHash("sha256").update(readFileSync(self)).digest("hex") !==
      process.env.HITCH_ANTIGRAVITY_EXTENSION_SHA256 ||
    JSON.parse(readFileSync(require.resolve("pi-agy/package.json"), "utf8"))
      .version !== "0.6.1-hitch.2"
  )
    fail();
  let registered = false;
  const adapter = {
    registerProvider(id: string, config: ProviderConfig): void {
      if (
        registered ||
        id !== "antigravity" ||
        !config.oauth ||
        !config.streamSimple ||
        !config.models?.some((m) => m.id === "gemini-3.8-flash")
      )
        fail();
      pi.registerProvider(id, {
        ...config,
        oauth: {
          ...config.oauth,
          login: async () => {
            throw new Error("antigravity-login-requires-operator-terminal");
          },
        },
      });
      registered = true;
    },
    on(event: string): void {
      if (event !== "session_start" && event !== "session_shutdown") fail();
    },
    registerCommand(): void {},
  };
  try {
    registerAntigravity(adapter as unknown as ExtensionAPI);
    if (!registered) fail();
    process.env.HITCH_ANTIGRAVITY_INSTALLED = "1";
  } catch {
    fail();
  }
}
