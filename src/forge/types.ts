import type { ThinkingLevel } from "../runtime/runtime.js";

export interface ForgeSelection {
  readonly kind: "preset" | "profile";
  readonly id: string;
}

export interface ForgeResourceSummary extends ForgeSelection {
  readonly name: string;
}

export interface ForgeResolved {
  readonly selection: ForgeSelection;
  readonly name: string;
  readonly mode: "replace" | "append" | "prepend";
  readonly systemPrompt: string;
  readonly tools?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: ThinkingLevel;
}

export interface ForgeRenderContext {
  readonly now: Date;
  readonly activeTools: readonly string[];
  readonly model?: { readonly provider: string; readonly id: string };
}

/** One immutable startup snapshot; no I/O or provider calls from commands. */
export interface ForgeCatalog {
  isEnabled(userId: string): boolean;
  list(kind: ForgeSelection["kind"]): readonly ForgeResourceSummary[];
  resolve(
    selection: ForgeSelection,
    context?: ForgeRenderContext,
  ): ForgeResolved;
}
