import { setTimeout as sleep } from "node:timers/promises";
const [, , authPath, providerId, mode = "refresh"] = process.argv;
const repository = new URL("../..", import.meta.url);
const { SharedCredentialStore } = await import(
  new URL("dist/src/pi/shared-credentials.js", repository).href
);
const store = new SharedCredentialStore(authPath);

// Test-only interruption at the durability boundary, never a production hook.
if (mode === "crash-before-rename") {
  const fs = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const originalRename = fs.default.rename;
  fs.default.rename = async (source, destination) => {
    if (destination === authPath) {
      process.stdout.write("commit-ready\n");
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
}

if (mode.startsWith("hold:")) {
  const milliseconds = Number(mode.slice("hold:".length));
  await store.modify(providerId, async (current) => {
    await sleep(milliseconds);
    return current;
  });
  process.stdout.write("held\n");
} else {
  let refreshed = false;
  await store.modify(providerId, async (current) => {
    if (current?.type !== "oauth")
      throw new Error("fixture credential unavailable");
    if (current.access !== "rotated-access") {
      refreshed = true;
      await sleep(120);
      return {
        ...current,
        access: "rotated-access",
        refresh: "rotated-refresh",
      };
    }
    return current;
  });
  process.stdout.write(`${JSON.stringify({ refreshed })}\n`);
}
