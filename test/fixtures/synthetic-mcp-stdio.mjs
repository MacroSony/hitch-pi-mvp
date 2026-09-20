// Standalone synthetic MCP stdio server for the opt-in real-Pi acceptance
// test. Extracted from test/hitch-mcp.test.ts so the real-Pi test does not
// import that file (which registers unrelated tests).
//
// It speaks the official `@modelcontextprotocol/sdk` protocol over stdin and
// stdout only: no sockets, no network, no credentials. The tool values are
// deliberately fixed sentinels, not market data.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Prefer an explicit SDK root (used when this file is copied into a temp
// tree); otherwise resolve the repository copy next to test/fixtures.
const sdkEsmRoot = process.env.HITCH_SYNTHETIC_MCP_SDK_ROOT
  ? process.env.HITCH_SYNTHETIC_MCP_SDK_ROOT
  : join(
      here,
      "..",
      "..",
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "dist",
      "esm",
    );

const { Server } = await import(
  pathToFileURL(join(sdkEsmRoot, "server", "index.js")).href
);
const { StdioServerTransport } = await import(
  pathToFileURL(join(sdkEsmRoot, "server", "stdio.js")).href
);
const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
  pathToFileURL(join(sdkEsmRoot, "types.js")).href
);

const server = new Server(
  { name: "hitch-synthetic-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "quote",
      description:
        "Synthetic local test fixture; returns a fixed value, not market data.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "other",
      description:
        "Synthetic local test fixture; returns a second fixed value, not market data.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "quote") {
    return { content: [{ type: "text", text: "synthetic_quote" }] };
  }
  if (request.params.name === "other") {
    return { content: [{ type: "text", text: "synthetic_other" }] };
  }
  throw new Error("unknown synthetic tool: " + request.params.name);
});

await server.connect(new StdioServerTransport());
