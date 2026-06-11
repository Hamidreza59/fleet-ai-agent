# fleet-ai-agent

An **AI fleet-manager agent** in TypeScript. It connects to the
[`fleet-mcp-server`](https://github.com/Hamidreza59/fleet-mcp-server) as an **MCP client**, gives those tools
to an LLM (**AWS Bedrock Converse** by default), and runs an agentic tool-use
loop to answer operational questions about a vehicle fleet.

> Sanitized, clean-room reference architecture with synthetic data — no
> proprietary code. This is the agent half of a two-part demo.

## What it does

Ask it a question and it will *use tools* to answer:

```
GET /fleet/alex/inquire?query=Which vehicles in FLEET-ATLAS need maintenance and why?
```

Behind that single request the agent:

1. Calls `get_fleet_summary` / `get_vehicle_data` on the MCP server to pull live readings.
2. Calls `search_maintenance_knowledge` (RAG) to explain DTC codes and cite policy thresholds.
3. Optionally calls `schedule_maintenance_appointment` (a local tool) to open a work order.
4. Returns a prioritized, structured recommendation — plus a trace of which tools it called.

## Architecture

```
  HTTP ──► Express ──► FleetAgent (tool-use loop)
                          │
                          ├── LlmProvider ──► Bedrock Converse (nova-lite)
                          │                   | OpenAI-compatible (Groq/Ollama)  ← free path
                          │                   | Mock (offline tests)
                          │
                          └── ToolBox ──► MCP tools  (fleet-mcp-server, via MCP)
                                          + local tools (schedule_maintenance)
       per-manager ChatMemory keeps follow-up context
```

Every dependency is an interface (`LlmProvider`, `ToolBox`), so the model and the
tool source are swappable — and the whole loop is unit-tested with a mock LLM and
a fake toolbox (no network, no credentials).

## Quick start (free, no AWS)

You need the MCP server installed first (`pip install -e .` in `fleet-mcp-server`,
which puts `fleet-mcp-server` on your PATH). Then:

```bash
cp .env.example .env
npm install

# Option A — fully offline smoke test (scripted mock LLM):
LLM_PROVIDER=mock npm start

# Option B — real, free LLM via Groq (get a free key at console.groq.com):
LLM_PROVIDER=openai-compatible OPENAI_API_KEY=gsk_... npm start
```

Then:

```bash
curl "http://localhost:3000/fleet/alex/inquire?query=Which%20vehicles%20in%20FLEET-ATLAS%20need%20maintenance?"
```

### Production path (AWS Bedrock)

```bash
LLM_PROVIDER=bedrock AWS_REGION=us-east-1 BEDROCK_MODEL_ID=amazon.nova-lite-v1:0 npm start
# Requires AWS credentials with bedrock:InvokeModel and model access enabled.
```

## Tests

```bash
npm test          # vitest — exercises the full tool-use loop with the mock LLM
npm run typecheck
```

## Connecting to the MCP server over HTTP instead of stdio

```bash
# In fleet-mcp-server:  FLEET_MCP_TRANSPORT=http fleet-mcp-server
MCP_TRANSPORT=http MCP_URL=http://localhost:8080/mcp npm start
```

## Project layout

```
src/
  index.ts            # Express wiring + /fleet/:manager/inquire
  agent.ts            # the tool-use loop + system prompt
  config.ts           # env-driven config
  llm/                # LlmProvider: bedrock | openai-compatible | mock (+ factory)
  mcp/client.ts       # MCP client → ToolBox (stdio or HTTP)
  tools/              # local tools + composite registry
  memory/             # per-manager chat memory
test/                 # vitest suite
```

## License

MIT — see [LICENSE](LICENSE).
