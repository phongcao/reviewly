import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AiProvider = "claude" | "codex" | "gemini" | "copilot" | "openai";

/** Providers that are a local CLI on PATH (vs. the HTTP OpenAI-compatible one). */
export const CLI_PROVIDERS: AiProvider[] = ["claude", "codex", "gemini", "copilot"];

/** Providers whose CLI takes a reasoning-effort level (`claude --effort`,
 * `copilot --reasoning-effort`). */
export const EFFORT_PROVIDERS: AiProvider[] = ["claude", "copilot"];

/** Short display name per provider (the "Thinking with …" label). */
export const PROVIDER_LABEL: Record<AiProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  copilot: "Copilot",
  openai: "your model",
};

/**
 * Common models per CLI provider — just suggestions for the free-text model
 * field (it accepts any id the CLI understands, so new models work without a
 * code change). Fable is a Claude model; each CLI takes its own set.
 */
export const MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  claude: [
    "default",
    "sonnet",
    "opus",
    "haiku",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "claude-fable-5-1",
  ],
  codex: ["gpt-5-codex", "gpt-5", "o3", "o4-mini", "gpt-4.1"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-exp"],
  copilot: [
    "auto",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-fable-5.1",
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.3-codex",
    "gemini-3.8-flash",
  ],
  openai: [],
};

/** Reasoning-effort levels the effort providers accept, lowest first. */
export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

/** Short effort text for tight spots, e.g. the layer bar's "opus-5-5 · med". */
export const EFFORT_SHORT: Record<string, string> = {
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

interface State {
  /** Which backend to use for reviews. */
  provider: AiProvider;
  setProvider: (provider: AiProvider) => void;
  /**
   * OpenAI-compatible endpoint config — used when provider === "openai".
   * Covers Ollama (local), LM Studio, OpenRouter, DeepSeek, Groq, etc.
   */
  baseUrl: string;
  model: string;
  /** Optional bearer key; local servers like Ollama need none. */
  apiKey: string;
  setOpenai: (cfg: Partial<Pick<State, "baseUrl" | "model" | "apiKey">>) => void;
  /** Optional model override per CLI provider (claude/codex/gemini/copilot). Empty = the CLI's own default. */
  cliModels: Partial<Record<AiProvider, string>>;
  setCliModel: (provider: AiProvider, model: string) => void;
  /** Reasoning effort for Claude and Copilot runs (`EFFORT_PROVIDERS`). `null`
   * = the CLI's own default. Other providers ignore it. Named before Copilot
   * took one too; kept so the saved setting carries over. */
  claudeEffort: AiEffort | null;
  setClaudeEffort: (effort: AiEffort | null) => void;
  /** How long an AI run may take before it's stopped, in seconds. `null` =
   * automatic (the backend picks 3 min, or 7 min when the PR's clone is present). */
  aiTimeoutSecs: number | null;
  setAiTimeoutSecs: (secs: number | null) => void;
}

export const useAiProvider = create<State>()(
  persist(
    (set) => ({
      provider: "claude",
      setProvider: (provider) => set({ provider }),
      baseUrl: "",
      model: "",
      apiKey: "",
      setOpenai: (cfg) => set(cfg),
      cliModels: {},
      setCliModel: (provider, model) =>
        set((s) => ({ cliModels: { ...s.cliModels, [provider]: model } })),
      claudeEffort: null,
      setClaudeEffort: (claudeEffort) => set({ claudeEffort }),
      aiTimeoutSecs: null,
      setAiTimeoutSecs: (aiTimeoutSecs) => set({ aiTimeoutSecs }),
    }),
    { name: "reviewly.ai", storage: sqlStorage<State>() },
  ),
);

/**
 * Extra invoke args for the `ai_review` / `ai_review_bg` commands. Carries the
 * OpenAI-compatible config when that provider is selected; the CLI providers
 * just get `{ provider }` and ignore the rest.
 */
export function aiInvokeArgs(): {
  provider: AiProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutSecs?: number;
  effort?: AiEffort;
} {
  const s = useAiProvider.getState();
  // `null`/0 → omit so the Rust side keeps its automatic default.
  const timeout = s.aiTimeoutSecs && s.aiTimeoutSecs > 0 ? { timeoutSecs: s.aiTimeoutSecs } : {};
  if (s.provider !== "openai") {
    const model = s.cliModels[s.provider]?.trim();
    const effort =
      EFFORT_PROVIDERS.includes(s.provider) && s.claudeEffort ? { effort: s.claudeEffort } : {};
    return { provider: s.provider, ...(model ? { model } : {}), ...effort, ...timeout };
  }
  return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, ...timeout };
}
