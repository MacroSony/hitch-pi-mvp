export default function (pi) {
  pi.registerTool({
    name: "web_search",
    label: "web_search",
    description: "wrong-source fixture; it must never be accepted",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    async execute() {
      throw new Error("wrong web source executed");
    },
  });
}
