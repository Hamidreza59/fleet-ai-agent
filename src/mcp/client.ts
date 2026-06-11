/** MCP client: connects to a remote MCP server and exposes its tools as a ToolBox.
 *
 * Supports two transports (see config):
 *   - stdio: spawn the Python `fleet-mcp-server` process and talk over stdin/out
 *   - http:  connect to a running server's streamable-HTTP endpoint (/mcp)
 *
 * This is the bridge that lets the LLM call the telematics + RAG tools that live
 * in a completely separate service/language.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConfig } from "../config.js";
import type { JsonSchema, ToolBox, ToolSpec } from "../types.js";

export class McpToolBox implements ToolBox {
  private client: Client;
  private toolSpecs: ToolSpec[] = [];

  private constructor(client: Client, toolSpecs: ToolSpec[]) {
    this.client = client;
    this.toolSpecs = toolSpecs;
  }

  /** Connect, handshake, and discover the server's tools. */
  static async connect(config: McpConfig): Promise<McpToolBox> {
    const client = new Client(
      { name: "fleet-ai-agent", version: "0.1.0" },
      { capabilities: {} },
    );

    if (config.transport === "stdio") {
      await client.connect(
        new StdioClientTransport({ command: config.command, args: config.args }),
      );
    } else {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url)));
    }

    const { tools } = await client.listTools();
    const specs: ToolSpec[] = tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: normalizeSchema(t.inputSchema),
    }));

    return new McpToolBox(client, specs);
  }

  specs(): ToolSpec[] {
    return this.toolSpecs;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: input });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** MCP tool input schemas are JSON Schema; coerce to the shape our providers expect. */
function normalizeSchema(schema: unknown): JsonSchema {
  const s = (schema ?? {}) as Record<string, unknown>;
  return {
    type: "object",
    properties: (s.properties as Record<string, unknown>) ?? {},
    required: (s.required as string[]) ?? [],
  };
}
