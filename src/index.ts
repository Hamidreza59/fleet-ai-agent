/** HTTP entrypoint: wires config → LLM → MCP tools → agent, behind Express. */

import express from "express";
import { loadConfig } from "./config.js";
import { createLlmProvider } from "./llm/index.js";
import { McpToolBox } from "./mcp/client.js";
import { ChatMemory } from "./memory/chatMemory.js";
import { CompositeToolBox, LocalToolBox } from "./tools/registry.js";
import { FleetAgent } from "./agent.js";
import { ApprovalQueue, type PendingApproval } from "./guardrails/approvals.js";
import { JsonlTrajectorySink, NullTrajectorySink } from "./trace/trajectory.js";

const APPROVAL_STATUSES = ["pending", "executing", "approved", "rejected", "failed"];

async function main() {
  const config = loadConfig();

  console.log(`[boot] LLM provider: ${config.llmProvider}`);
  console.log(`[boot] connecting to MCP server via ${config.mcp.transport}...`);
  const mcpTools = await McpToolBox.connect(config.mcp);
  console.log(`[boot] MCP tools: ${mcpTools.specs().map((t) => t.name).join(", ")}`);

  const tools = new CompositeToolBox([mcpTools, new LocalToolBox()]);
  const llm = createLlmProvider(config);
  const memory = new ChatMemory();
  const approvals = new ApprovalQueue();
  const agent = new FleetAgent(llm, tools, memory, {
    maxIterations: config.maxToolIterations,
    writePolicy: config.writeToolPolicy,
    budget: { maxTokens: config.maxTokensPerRun, maxCostUsd: config.maxCostUsdPerRun },
    approvals,
    sink: config.trajectoryFile ? new JsonlTrajectorySink(config.trajectoryFile) : new NullTrajectorySink(),
  });

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
      const { trajectory: _trajectory, ...body } = result;
      res.json(body);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    }
  };

  app.get("/fleet/:manager/inquire", handle);
  app.post("/fleet/:manager/inquire", handle);

  app.get("/approvals", (req, res) => {
    const status = req.query.status as string | undefined;
    if (status !== undefined && !APPROVAL_STATUSES.includes(status as PendingApproval["status"])) {
      res.status(400).json({ error: `status must be one of: ${APPROVAL_STATUSES.join(", ")}` });
      return;
    }
    res.json(approvals.list(status as PendingApproval["status"] | undefined));
  });

  const resolve = (action: "approve" | "reject") => async (req: express.Request, res: express.Response) => {
    const id = req.params.id;
    const item = approvals.get(id);
    if (!item) {
      res.status(404).json({ error: `Unknown approval ${id}` });
      return;
    }
    if (item.status !== "pending") {
      res.status(409).json({ error: `Approval ${id} is already ${item.status}` });
      return;
    }
    res.json(action === "approve" ? await approvals.approve(id, tools) : approvals.reject(id));
  };
  app.post("/approvals/:id/approve", resolve("approve"));
  app.post("/approvals/:id/reject", resolve("reject"));

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
