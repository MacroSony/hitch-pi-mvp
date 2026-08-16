import { ProxyAgent, fetch as undiciFetch } from "undici";

/**
 * Returns a fetch implementation that sends Telegram Bot API requests through
 * the configured HTTPS proxy. WeChat CDN requests keep the platform default
 * fetch and intentionally stay on a direct path: proxying large WeChat CDN
 * responses has produced truncated downloads during dogfood.
 */
const platformFetch: typeof fetch = globalThis.fetch;

export function proxyFetcher(proxyUrl: string | undefined): typeof fetch {
  if (proxyUrl === undefined || proxyUrl.length === 0) return platformFetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  return ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) =>
    (undiciFetch as unknown as typeof fetch)(input, {
      ...init,
      dispatcher,
    } as unknown as Parameters<typeof fetch>[1])) as unknown as typeof fetch;
}
