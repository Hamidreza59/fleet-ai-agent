/** HTTP entrypoint: wires config → LLM → MCP tools → agent, behind Express. */

import express from "express";
import { loadConfig } from "./config.js";
import { createLlmProvider } from "./llm/index.js";
import { McpToolBox } from "./mcp/client.js";
import { ChatMemory } from "./memory/chatMemory.js";
import { CompositeToolBox, LocalToolBox } from "./tools/registry.js";
import { FleetAgent } from "./agent.js";

async function main() {
  const config = loadConfig();

  console.log(`[boot] LLM provider: ${config.llmProvider}`);
  console.log(`[boot] connecting to MCP server via ${config.mcp.transport}...`);
  const mcpTools = await McpToolBox.connect(config.mcp);
  console.log(`[boot] MCP tools: ${mcpTools.specs().map((t) => t.name).join(", ")}`);

  const tools = new CompositeToolBox([mcpTools, new LocalToolBox()]);
  const llm = createLlmProvider(config);
  const memory = new ChatMemory();
  const agent = new FleetAgent(llm, tools, memory, config.maxToolIterations);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", llm: config.llmProvider, tools: tools.specs().map((t) => t.name) });
  });

  // GET or POST /fleet/:manager/inquire?query=...
  const handle = async (req: express.Request, res: express.Response) => {
    const manager = req.params.manager;
    const query = (req.query.query ?? req.body?.query) as string | undefined;
    if (!query) {
      res.status(400).json({ error: "Provide a 'query' parameter." });
      return;
    }
    try {
      const result = await agent.inquire(manager, query);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    }
  };

  app.get("/fleet/:manager/inquire", handle);
  app.post("/fleet/:manager/inquire", handle);

  app.listen(config.port, () => {
    console.log(`[ready] fleet-ai-agent listening on http://localhost:${config.port}`);
    console.log(`        try: GET /fleet/alex/inquire?query=Which vehicles need maintenance?`);
  });

  const shutdown = async () => {
    await mcpTools.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
