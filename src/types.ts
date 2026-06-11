/** Shared, provider-agnostic types for the agent loop. */

/** A JSON-schema-ish description of a tool's input. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/** What the LLM is told a tool can do. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Normalized conversation message, translated per-provider. */
export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; result: string };

/** One model turn: free text and/or a set of tool calls to run. */
export interface LlmResponse {
  text?: string;
  toolCalls: ToolCall[];
}

/** The seam every LLM backend implements (Bedrock, OpenAI-compatible, mock). */
export interface LlmProvider {
  readonly name: string;
  converse(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<LlmResponse>;
}

/**
 * A set of callable tools exposed to the agent. The MCP client implements this
 * against a remote MCP server; local tools are merged in. Keeping the agent
 * dependent on this interface (not on MCP directly) makes it trivial to test.
 */
export interface ToolBox {
  specs(): ToolSpec[];
  execute(name: string, input: Record<string, unknown>): Promise<string>;
}
