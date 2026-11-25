/** OpenAI-compatible chat-completions provider — the free/local path.
 *
 * Works with any OpenAI-compatible endpoint that supports tool calling:
 *   - Groq         (free API key, fast)        https://api.groq.com/openai/v1
 *   - OpenRouter   (free-tier models)          https://openrouter.ai/api/v1
 *   - Ollama       (fully local, no key)       http://localhost:11434/v1
 *   - OpenAI       (paid)                       https://api.openai.com/v1
 *
 * Implemented with `fetch` so it adds no SDK dependency.
 */

import type { ChatMessage, LlmProvider, LlmResponse, ToolCall, ToolSpec } from "../types.js";

interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export class OpenAICompatibleLlmProvider implements LlmProvider {
  readonly name = "openai-compatible";

  constructor(
    private baseUrl: string,
    private apiKey: string,
    readonly model: string,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async converse(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse> {
    const body = {
      model: this.model,
      temperature: 0.2,
      messages: [{ role: "system", content: system }, ...messages.map(toOpenAIMessage)],
      tools: tools.length ? tools.map(toOpenAITool) : undefined,
      tool_choice: tools.length ? "auto" : undefined,
    };

    const res = await this.post(JSON.stringify(body));

    if (!res.ok) {
      throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: OpenAIToolCall[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = data.choices[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: safeParse(tc.function.arguments),
    }));

    const usage = data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : undefined;
    return { text: message?.content ?? undefined, toolCalls, usage };
  }

  private async post(body: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body,
      });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) return res;
      await res.body?.cancel();
      await this.sleep(retryDelayMs(res, attempt));
    }
  }
}

const MAX_RETRIES = 3;
const MAX_DELAY_MS = 30_000;

function retryDelayMs(res: Response, attempt: number): number {
  const secs = Number(res.headers.get("retry-after"));
  return Math.min(MAX_DELAY_MS, Number.isFinite(secs) && secs > 0 ? secs * 1000 : 2000 * 2 ** attempt);
}

function toOpenAITool(spec: ToolSpec) {
  return {
    type: "function" as const,
    function: { name: spec.name, description: spec.description, parameters: spec.inputSchema },
  };
}

function toOpenAIMessage(msg: ChatMessage): Record<string, unknown> {
  if (msg.role === "user") return { role: "user", content: msg.text };
  if (msg.role === "assistant") {
    return {
      role: "assistant",
      content: msg.text ?? "",
      tool_calls: msg.toolCalls?.length
        ? msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }))
        : undefined,
    };
  }
  return { role: "tool", tool_call_id: msg.toolCallId, content: msg.result };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
