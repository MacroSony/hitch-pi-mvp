import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callLocal, LocalClientError } from "./client.js";
import type { LocalRequest } from "./types.js";

const SERVER_NAME = "hitch-local-control";
const SERVER_VERSION = "0.1.0";
const MAX_IDENTIFIER_CHARS = 128;
const MAX_TEXT_CHARS = 16 * 1024;

const identifierSchema = (label: string): z.ZodString =>
  z.string().min(1).max(MAX_IDENTIFIER_CHARS).describe(label);

const requestIdSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_CHARS)
  .describe(
    "Caller-owned idempotency key; reuse with the same request is safe.",
  );

const userIdSchema = identifierSchema(
  "Owned Hitch user id; must be in the caller's static allowlist.",
);
const channelSchema = z
  .enum(["telegram", "wechat", "wecom"])
  .describe(
    "Optional endpoint channel; required when the user has more than one endpoint.",
  );
const scheduleIdSchema = identifierSchema(
  "Schedule id returned by hitch_schedule_create.",
);
const deliveryIdSchema = identifierSchema(
  "Delivery id returned by hitch_notify or a schedule fire.",
);
const sessionIdSchema = identifierSchema(
  "Explicit owned session id from hitch_targets; required for wake schedules.",
);

const timeOfDaySchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
  .describe("Local wall-clock time HH:MM.");
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .describe("Calendar date YYYY-MM-DD.");
const timezoneSchema = z
  .string()
  .min(1)
  .max(128)
  .describe("Explicit IANA timezone, for example Europe/Berlin.");

const recurrenceSchema = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("once"), date: dateSchema })
      .strict()
      .describe("One fire on the given local date."),
    z
      .object({ kind: z.literal("daily") })
      .strict()
      .describe("Fire every local day at timeOfDay."),
    z
      .object({
        kind: z.literal("weekly"),
        weekdays: z
          .array(z.number().int().min(0).max(6))
          .min(1)
          .max(7)
          .refine(
            (weekdays) =>
              weekdays.every(
                (weekday, index) =>
                  index === 0 || weekday > weekdays[index - 1]!,
              ),
            { message: "weekdays must be sorted ascending and unique" },
          )
          .describe(
            "Sorted ascending, unique weekdays, 0=Sunday … 6=Saturday.",
          ),
      })
      .strict()
      .describe("Fire on the selected local weekdays."),
  ])
  .describe("Structured recurrence: once, daily, or weekly.");

export interface LocalMcpEnvironment {
  readonly socketPath: string;
  readonly callerId: string;
  readonly token: string;
}

/**
 * Reads only the three dedicated control variables. Secret names are safe to
 * mention; the values are never logged, echoed, or put in errors.
 */
export function readLocalMcpEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): LocalMcpEnvironment {
  const socketPath = environment.HITCH_CONTROL_SOCKET;
  if (socketPath === undefined || socketPath.length === 0) {
    throw new Error("HITCH_CONTROL_SOCKET is required");
  }
  const callerId = environment.HITCH_CONTROL_CALLER;
  if (callerId === undefined || callerId.length === 0) {
    throw new Error("HITCH_CONTROL_CALLER is required");
  }
  const token = environment.HITCH_CONTROL_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("HITCH_CONTROL_TOKEN is required");
  }
  return { socketPath, callerId, token };
}

type ToolArguments = Readonly<Record<string, unknown>>;

function withoutUndefined(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

/**
 * Maps one MCP tool call to the stable local-control method and camelCase
 * params. The socket transport re-validates the method and action allowlist.
 */
export function translateToolCall(
  toolName: string,
  args: ToolArguments,
): LocalRequest {
  switch (toolName) {
    case "hitch_targets":
      return { method: "targets.list", params: {} };
    case "hitch_notify":
      return {
        method: "notify",
        params: withoutUndefined({
          requestId: args.requestId,
          userId: args.userId,
          text: args.text,
          channel: args.channel,
        }),
      };
    case "hitch_delivery_status":
      return {
        method: "delivery.get",
        params: withoutUndefined({
          userId: args.userId,
          deliveryId: args.deliveryId,
        }),
      };
    case "hitch_schedule_create":
      return {
        method: "schedule.create",
        params: withoutUndefined({
          requestId: args.requestId,
          userId: args.userId,
          action: args.action,
          text: args.text,
          recurrence: args.recurrence,
          timeOfDay: args.timeOfDay,
          timezone: args.timezone,
          channel: args.channel,
          sessionId: args.sessionId,
        }),
      };
    case "hitch_schedule_list":
      return {
        method: "schedule.list",
        params: withoutUndefined({ userId: args.userId }),
      };
    case "hitch_schedule_set_enabled":
      return {
        method: "schedule.set_enabled",
        params: withoutUndefined({
          requestId: args.requestId,
          userId: args.userId,
          scheduleId: args.scheduleId,
          enabled: args.enabled,
        }),
      };
    case "hitch_schedule_cancel":
      return {
        method: "schedule.cancel",
        params: withoutUndefined({
          requestId: args.requestId,
          userId: args.userId,
          scheduleId: args.scheduleId,
        }),
      };
    default:
      throw new Error("unknown local control tool");
  }
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function success(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: render(value) }] };
}

function failure(error: unknown): CallToolResult {
  const code = error instanceof LocalClientError ? error.code : "unavailable";
  return {
    isError: true,
    content: [{ type: "text", text: `local-control ${code}` }],
  };
}

export function registerLocalTools(
  server: McpServer,
  environment: LocalMcpEnvironment,
): void {
  const invoke = async (request: LocalRequest): Promise<CallToolResult> => {
    try {
      const result = await callLocal(
        environment.socketPath,
        environment.callerId,
        environment.token,
        request,
      );
      return success(result);
    } catch (error) {
      return failure(error);
    }
  };

  server.registerTool(
    "hitch_targets",
    {
      title: "List allowed targets",
      description:
        "List the caller's allowed Hitch users, endpoints, and owned sessions.",
    },
    async () => invoke({ method: "targets.list", params: {} }),
  );

  server.registerTool(
    "hitch_notify",
    {
      title: "Send a literal notification",
      description:
        "Enqueue literal operator text on an allowed user endpoint. No model runs; queued is acceptance, not delivery or a read receipt.",
      inputSchema: {
        requestId: requestIdSchema,
        userId: userIdSchema,
        text: z.string().min(1).max(MAX_TEXT_CHARS).describe("Literal text."),
        channel: channelSchema.optional(),
      },
    },
    async (args) =>
      invoke(translateToolCall("hitch_notify", args as ToolArguments)),
  );

  server.registerTool(
    "hitch_delivery_status",
    {
      title: "Read notification delivery status",
      description:
        "Return queued or terminal delivery state for a prior delivery id. Queued is not a read receipt.",
      inputSchema: {
        userId: userIdSchema,
        deliveryId: deliveryIdSchema,
      },
    },
    async (args) =>
      invoke(translateToolCall("hitch_delivery_status", args as ToolArguments)),
  );

  server.registerTool(
    "hitch_schedule_create",
    {
      title: "Create a schedule",
      description:
        "Schedule a one-time/daily/weekly literal notification or wake task in an explicit IANA timezone. Queued fires are not read receipts.",
      inputSchema: {
        requestId: requestIdSchema,
        userId: userIdSchema,
        action: z
          .enum(["notify", "wake"])
          .describe("notify sends literal text; wake queues a model task."),
        text: z
          .string()
          .min(1)
          .max(MAX_TEXT_CHARS)
          .describe("Literal text or wake prompt."),
        recurrence: recurrenceSchema,
        timeOfDay: timeOfDaySchema,
        timezone: timezoneSchema,
        channel: channelSchema.optional(),
        sessionId: sessionIdSchema
          .optional()
          .describe("Required for wake schedules; the explicit owned session."),
      },
    },
    async (args) =>
      invoke(translateToolCall("hitch_schedule_create", args as ToolArguments)),
  );

  server.registerTool(
    "hitch_schedule_list",
    {
      title: "List schedules",
      description: "List the caller's owned schedules for one allowed user.",
      inputSchema: { userId: userIdSchema },
    },
    async (args) =>
      invoke(translateToolCall("hitch_schedule_list", args as ToolArguments)),
  );

  server.registerTool(
    "hitch_schedule_set_enabled",
    {
      title: "Enable or disable a schedule",
      description: "Pause or resume an owned schedule.",
      inputSchema: {
        requestId: requestIdSchema,
        userId: userIdSchema,
        scheduleId: scheduleIdSchema,
        enabled: z.boolean(),
      },
    },
    async (args) =>
      invoke(
        translateToolCall("hitch_schedule_set_enabled", args as ToolArguments),
      ),
  );

  server.registerTool(
    "hitch_schedule_cancel",
    {
      title: "Cancel a schedule",
      description: "Cancel an owned schedule; it cannot be resumed.",
      inputSchema: {
        requestId: requestIdSchema,
        userId: userIdSchema,
        scheduleId: scheduleIdSchema,
      },
    },
    async (args) =>
      invoke(translateToolCall("hitch_schedule_cancel", args as ToolArguments)),
  );
}

export async function runLocalMcpServer(
  environment: LocalMcpEnvironment,
): Promise<void> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerLocalTools(server, environment);
  await server.connect(new StdioServerTransport());
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

async function main(): Promise<void> {
  let environment: LocalMcpEnvironment;
  try {
    environment = readLocalMcpEnvironment();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "configuration error";
    process.stderr.write(`hitch mcp startup failed: ${message}\n`);
    process.exitCode = 1;
    return;
  }
  await runLocalMcpServer(environment);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "unknown startup failure";
    process.stderr.write(`hitch mcp failed: ${message}\n`);
    process.exitCode = 1;
  });
}
