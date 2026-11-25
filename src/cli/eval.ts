/** `npm run eval -- [--tags a,b] [--case id] [--trials N] [--judge] [--min-pass-rate x] [--baseline f] [--record f] [--record-passing-only] [--replay f] [--out dir]` */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FleetAgent } from "../agent.js";
import { loadConfig } from "../config.js";
import { baselineSkipReason, findRegressions, renderMarkdown } from "../evals/report.js";
import { runEvals, runReplayEvals } from "../evals/runner.js";
import type { EvalCase, EvalReport } from "../evals/types.js";
import { ApprovalQueue } from "../guardrails/approvals.js";
import { createLlmProvider } from "../llm/index.js";
import { McpToolBox } from "../mcp/client.js";
import { ChatMemory } from "../memory/chatMemory.js";
import { CompositeToolBox, LocalToolBox } from "../tools/registry.js";
import { readTrajectories } from "../trace/trajectory.js";

function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    flags.set(argv[i].slice(2), hasValue ? next : "true");
    if (hasValue) i++;
  }
  return flags;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawMin = (args.get("min-pass-rate") ?? process.env.EVAL_MIN_PASS_RATE ?? "").trim();
  const minPassRate = rawMin === "" ? 0.8 : Number(rawMin);
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    console.error(`Invalid min pass rate "${rawMin}": must be a number between 0 and 1`);
    process.exit(2);
  }
  const outDir = args.get("out") ?? "evals/reports";
  const trials = Number(args.get("trials") ?? 1);
  if (!Number.isInteger(trials) || trials < 1) {
    console.error(`Invalid --trials "${args.get("trials")}": must be a positive integer`);
    process.exit(2);
  }

  let cases = JSON.parse(readFileSync("evals/cases.json", "utf8")) as EvalCase[];
  const tags = args.get("tags")?.split(",").filter(Boolean);
  if (tags) cases = cases.filter((c) => c.tags.some((t) => tags.includes(t)));
  const only = args.get("case");
  if (only) cases = cases.filter((c) => c.id === only);
  if (cases.length === 0) throw new Error("No eval cases selected");

  let report: EvalReport;
  const replayFile = args.get("replay");
  if (replayFile) {
    report = await runReplayEvals(cases, readTrajectories(replayFile));
  } else {
    const config = loadConfig();
    const mcp = await McpToolBox.connect(config.mcp);
    try {
      const tools = new CompositeToolBox([mcp, new LocalToolBox()]);
      const llm = createLlmProvider(config);
      const recordFile = args.get("record");
      mkdirSync(outDir, { recursive: true });
      const allFile = join(outDir, "trajectories.jsonl");
      writeFileSync(allFile, "");
      const passingOnly = args.has("record-passing-only");
      if (recordFile) mkdirSync(dirname(recordFile), { recursive: true });
      report = await runEvals({
        cases,
        trials,
        judge: args.has("judge") ? llm : undefined,
        makeAgent: (writePolicy) =>
          new FleetAgent(llm, tools, new ChatMemory(), {
            maxIterations: config.maxToolIterations,
            writePolicy,
            approvals: new ApprovalQueue(),
            budget: { maxTokens: config.maxTokensPerRun, maxCostUsd: config.maxCostUsdPerRun },
          }),
        onTrajectory: (t, info) => {
          appendFileSync(allFile, JSON.stringify(t) + "\n");
          if (recordFile && (info.pass || !passingOnly)) appendFileSync(recordFile, JSON.stringify(t) + "\n");
        },
        onCase: (c) => console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id} ${c.failedScorers.join(",")}`),
      });
    } finally {
      await mcp.close();
    }
  }

  const md = renderMarkdown(report);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "latest.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "latest.md"), md);
  console.log("\n" + md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

  let failed = false;
  if (report.summary.passRate < minPassRate) {
    console.error(`Pass rate ${report.summary.passRate.toFixed(2)} is below minimum ${minPassRate}`);
    failed = true;
  }
  const baselineFile = args.get("baseline");
  if (baselineFile && !existsSync(baselineFile)) {
    console.warn(`Baseline ${baselineFile} not found; skipping regression check`);
  } else if (baselineFile) {
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as EvalReport;
    const skip = baselineSkipReason(baseline, report);
    if (skip) {
      console.warn(skip);
    } else {
      const regressions = findRegressions(baseline, report);
      if (regressions.length) {
        console.error(`Regressions vs baseline: ${regressions.join(", ")}`);
        failed = true;
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
