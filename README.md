# fleet-ai-agent

An **AI fleet-manager agent** in TypeScript. It connects to the
[`fleet-mcp-server`](https://github.com/Hamidreza59/fleet-mcp-server) as an **MCP client**, gives those tools
to an LLM (**AWS Bedrock Converse** by default), and runs an agentic tool-use
loop to answer operational questions about a vehicle fleet.

> Built from scratch as a reference architecture, using synthetic data.
> This is the agent half of a two-part demo.

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

![Architecture diagram](docs/architecture.png)

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

## Evaluation, trajectories & guardrails

Every run is captured as a structured **trajectory** (LLM steps with token usage, tool steps with
status and latency, memory snapshot, tool specs offered), scored by an **eval suite**, and wrapped in
**guardrails**.

**Trajectories.** Each `inquire` appends one JSON line to `TRAJECTORY_FILE` (default `runs/trajectories.jsonl`,
empty disables). Replay re-executes the current agent code against the recorded LLM responses and tool outputs:

```bash
npm run replay -- runs/trajectories.jsonl --last          # deterministic re-run + diff
npm run replay -- runs/trajectories.jsonl --run <runId>
npm run replay -- runs/trajectories.jsonl --last --live   # new model/prompt vs. the recorded tool world
```

**Guardrails.** Guards run before every tool call, in order, first non-allow wins:
`vin_format` (17-char VIN, no I/O/Q), `vin_grounding` (side-effecting tools may only use a VIN seen in the
question, an earlier user turn, or a successful tool output; guard messages and error payloads never count), `write_policy` (`WRITE_TOOL_POLICY=allow|approval|deny`). Under `approval`
(default) a side-effecting call is queued, not executed, and the model is told it is pending:

```
GET  /approvals?status=pending
POST /approvals/:id/approve     # executes the tool
POST /approvals/:id/reject      # 404 unknown id, 409 not pending (a second concurrent approve gets 409)
# GET /approvals?status= accepts pending|executing|approved|rejected|failed, else 400
```

A per-run budget (`MAX_TOKENS_PER_RUN`, `MAX_COST_USD_PER_RUN`) stops the loop with
`stopReason: "budget_exceeded"` before any further tool runs.

**Evals.** `evals/cases.json` holds 21 cases (tool selection, arguments, answer content/order, side effects,
refusals, memory, prompt injection). Always-on scorers: `stop_reason` and `grounded_identifiers` (every VIN/DTC
in the answer must appear in the user text or a successful tool output; DTCs do not count if they only appear in knowledge-base results, which list every code). It checks presence, not association: with several vehicles fetched it cannot tell which VIN a code belongs to. Cases with a `rubric` can also be graded by
an LLM judge (`--judge`, pass at score >= 4; the judge is the same model as the agent, so it is biased toward its own output).

```bash
npm run eval -- [--tags smoke] [--case <id>] [--trials 3] [--judge] \
  [--min-pass-rate 0.8] [--baseline evals/baselines/<model>.json] \
  [--record f.jsonl [--record-passing-only]] [--out evals/reports]
# every run also writes all trajectories to <out>/trajectories.jsonl
npm run eval:replay    # offline: replays evals/golden/trajectories.jsonl, no LLM or MCP server needed
```

Reports go to `evals/reports/latest.{json,md}` (and `$GITHUB_STEP_SUMMARY` in CI). With `--trials N` a case
passes only if all trials pass (pass^k). The process exits 1 below the minimum pass rate or on any regression
against the baseline. Baselines are per model (`evals/baselines/<model-slug>.json`); a baseline for a different model is skipped with a warning.

**CI.** `npm run typecheck`, `npm test` and `npm run eval:replay` run on every push/PR (the replay gate catches
regressions in loop, guard and scorer code without any model calls). A weekly/manual `live-eval` job runs the
`smoke` cases against Groq when the `OPENAI_API_KEY` secret is set (min pass rate 0.5, regression check against `evals/baselines/llama-3.3-70b-versatile.json` if present). `uv sync` for the server repo is unpinned because it has no `uv.lock`.

Additional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `WRITE_TOOL_POLICY` | `approval` | `allow`, `approval` or `deny` for side-effecting tools |
| `MAX_TOKENS_PER_RUN` | `50000` | per-request token cap |
| `MAX_COST_USD_PER_RUN` | `0.05` | per-request cost cap |
| `PRICE_INPUT_PER_MTOK` / `PRICE_OUTPUT_PER_MTOK` | built-in table | USD per 1M tokens, overrides the table |
| `TRAJECTORY_FILE` | `runs/trajectories.jsonl` | trajectory log; empty disables |
| `EVAL_MIN_PASS_RATE` | `0.8` | eval gate threshold (number in [0,1]) |

### Results and improvement loop

All runs: local Ollama `qwen2.5:14b`, temperature 0.2, 1 trial, LLM judge on. "Rescored" means the stored answers and trajectories were re-scored offline against the final `evals/cases.json` (no new model calls); the v1 rescore uses the stored report answers because v1 trajectories were not saved. "With judge" counts a judge score below 4 as a failure; "deterministic only" excludes the judge.

| run | as recorded | rescored on final cases, deterministic only | rescored, with judge | tokens, latency |
|---|---|---|---|---|
| v1 (old prompt) | 11/21 | 13/21 | 12/21 | 95,857 tokens, p50/p95 10.7s/70.1s |
| v2 run A | 18/21 | 20/21 | 18/21 | 60,423 tokens, p50/p95 21.0s/63.3s |
| v2 run B (committed baseline) | 17/21 | 20/21 | 17/21 | 69,967 tokens, p50/p95 22.3s/57.4s |

1. **v1 failure analysis** (from the v1 report answers). The dominant failure was unprompted booking: in 7 non-booking cases the model made 8 `schedule_maintenance_appointment` calls instead of answering (the guardrails queued each one, so nothing executed) and the answer said "scheduled, awaiting approval". In the stored v2 reports (A and B) the count is 0.
2. **Change.** The system prompt now says to call the scheduling tool only when the user explicitly asks to book service, and the `PENDING_APPROVAL` result tells the model to still answer the rest of the question. Case corrections were made at the same time.
3. **Attribution.** Case corrections account for +1 on v1 (11 to 12 with judge). The rest of the improvement (12 to 17-18) is the prompt change, plus run-to-run variance: runs A and B differ by one case (`silverado-long-route`) with identical code and prompt. Latency is not comparable across runs (different machine load).

Remaining failures:
- `p0301-first-appearance`: the model queried 2023 dates (it has no notion of the current date), got an empty timeline, and did not recover.
- `grounding-trap-no-vins`: the model took the example VIN from the MCP tool description (a real fleet VIN), guessed other VINs and fabricated per-vehicle data. The deterministic scorers did not catch it; only the judge did.
- `prioritize-transit-vs-silverado` and (in run B) `silverado-long-route`: the model invented DTC meanings without calling the knowledge search; the judge caught both. The deterministic check for the prioritization case is lenient by design, so the judge is its backstop.

The 17 passing trajectories from run B are the offline gate in `evals/golden/trajectories.jsonl` (`npm run eval:replay`, 100%). `evals/baselines/qwen2.5-14b.v1.json`, `.v2a.json` and `.json` are the raw reports as the runs produced them.

### Limitations

- The approval queue is in memory (lost on restart) and the `/approvals` endpoints have no authentication.
- An approved tool's result is stored on the approval but not fed back into the conversation or the trajectory.
- Grounding is a blocklist, not provenance: it ignores guard messages and error payloads, but prose such as "VIN X not found" or a nested error object can still ground a VIN. It also checks that a VIN was seen, not that it belongs to the vehicle being discussed.
- The server's tool docstrings use a real fleet VIN as the schema example, which leaks into model calls. Using an out-of-fleet example VIN in those docstrings would avoid it (not changed here).
- With `--judge`, a judge failure fails the case; the judge is the same model as the agent.

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
  guardrails/         # tool guards, approval queue, token/cost budget
  trace/              # trajectory types + JSONL sink, deterministic replay
  evals/              # scorers, LLM judge, runner, report rendering
  cli/                # eval and replay entrypoints
evals/                # cases.json, baselines/<model>.json, golden/trajectories.jsonl
test/                 # vitest suite
```

## License

MIT — see [LICENSE](LICENSE).
