/** Centralized configuration, read from the environment with sane defaults. */

export interface Config {
  port: number;
  llmProvider: "bedrock" | "openai-compatible" | "mock";
  maxToolIterations: number;

  // Bedrock
  awsRegion: string;
  bedrockModelId: string;

  // OpenAI-compatible (Groq / OpenRouter / Ollama / OpenAI)
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;

  // MCP server connection
  mcp: McpConfig;
}

export type McpConfig =
  | { transport: "stdio"; command: string; args: string[] }
  | { transport: "http"; url: string };

function mcpConfig(): McpConfig {
  const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport === "http") {
    return { transport: "http", url: process.env.MCP_URL ?? "http://localhost:8080/mcp" };
  }
  // Default: spawn the Python server over stdio.
  const command = process.env.MCP_COMMAND ?? "fleet-mcp-server";
  const args = (process.env.MCP_ARGS ?? "").split(" ").filter(Boolean);
  return { transport: "stdio", command, args };
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    llmProvider: (process.env.LLM_PROVIDER ?? "bedrock") as Config["llmProvider"],
    maxToolIterations: Number(process.env.MAX_TOOL_ITERATIONS ?? 6),

    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    bedrockModelId: process.env.BEDROCK_MODEL_ID ?? "amazon.nova-lite-v1:0",

    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.groq.com/openai/v1",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiModel: process.env.OPENAI_MODEL ?? "llama-3.3-70b-versatile",

    mcp: mcpConfig(),
  };
}
