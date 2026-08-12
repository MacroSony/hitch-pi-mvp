import { AppError } from "./errors.js";

export type Command =
  | { readonly kind: "new"; readonly name?: string }
  | { readonly kind: "sessions" }
  | { readonly kind: "switch"; readonly selector: string }
  | { readonly kind: "status" }
  | { readonly kind: "abort" }
  | { readonly kind: "stop" }
  | { readonly kind: "recover" }
  | { readonly kind: "unknown"; readonly name: string };

function boundedArgument(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new AppError("rejected", `${label} is required`);
  if (
    Buffer.byteLength(trimmed, "utf8") > 64 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new AppError("rejected", `${label} is invalid`);
  }
  return trimmed;
}

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  const firstSpace = trimmed.search(/\s/u);
  const name = (
    firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)
  ).toLowerCase();
  const argument = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  switch (name) {
    case "new": {
      const value = argument.trim();
      return value.length === 0
        ? { kind: "new" }
        : { kind: "new", name: boundedArgument(value, "session name") };
    }
    case "sessions":
      return { kind: "sessions" };
    case "switch":
      return {
        kind: "switch",
        selector: boundedArgument(argument, "session selector"),
      };
    case "status":
      return { kind: "status" };
    case "abort":
      return { kind: "abort" };
    case "stop":
      return { kind: "stop" };
    case "recover":
      return { kind: "recover" };
    default:
      return { kind: "unknown", name: name.slice(0, 64) };
  }
}
