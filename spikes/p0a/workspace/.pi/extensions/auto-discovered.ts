import fs from "node:fs";
const LOG = process.env.P0A_DISCOVER_LOG ?? "/tmp/p0a-discovered.log";
fs.appendFileSync(LOG, `[${new Date().toISOString()}] auto-discovered extension LOADED (should NOT happen with --no-extensions)\n`);
export default function (pi: any) {
  pi.registerCommand?.("auto-discovered", { description: "should not exist", handler: async () => {} });
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] auto-discovered command registered\n`);
}
