/** `npm run replay -- [file] [--run <id> | --last] [--live]` */

import { loadConfig } from "../config.js";
import { createLlmProvider } from "../llm/index.js";
import { replayTrajectory } from "../trace/replay.js";
import { readTrajectories } from "../trace/trajectory.js";

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const last = args.includes("--last");
  const runIdx = args.indexOf("--run");
  const runId = runIdx >= 0 ? args[runIdx + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--run");
  const config = loadConfig();
  const file = positional[0] ?? config.trajectoryFile;
  if (!file) throw new Error("No trajectory file: pass one or set TRAJECTORY_FILE");

  let trajs = readTrajectories(file);
  if (runId) trajs = trajs.filter((t) => t.runId === runId);
  else if (last) trajs = trajs.slice(-1);
  if (trajs.length === 0) throw new Error("No matching trajectories");

  const llm = live ? createLlmProvider(config) : undefined;
  if (llm) console.log(`live provider: ${llm.name}/${llm.model}`);
  for (const t of trajs) {
    const { diff, replayed } = await replayTrajectory(t, {
      llm,
      maxIterations: live ? config.maxToolIterations : undefined,
    });
    console.log(`run ${t.runId}  [${t.metadata.caseId ?? "-"}]  ${t.provider}/${t.model}`);
    console.log(`  question: ${t.question}`);
    console.log(`  tools:    ${diff.originalTools.join(" > ") || "(none)"}`);
    if (diff.toolSequenceChanged) console.log(`  replayed: ${diff.replayedTools.join(" > ") || "(none)"}`);
    console.log(`  tool sequence changed: ${diff.toolSequenceChanged}`);
    console.log(`  answer changed:        ${diff.answerChanged}`);
    console.log(`  stop reason changed:   ${diff.stopReasonChanged} (${t.stopReason} -> ${replayed.stopReason})`);
    for (const c of diff.changedSteps) console.log(`  changed step ${c}`);
    for (const u of diff.unusedRecorded) console.log(`  unused recorded: ${u}`);
    for (const r of diff.reused) console.log(`  reused recorded output: ${r}`);
    for (const m of diff.misses) console.log(`  MISS: ${m}`);
    if (diff.answerChanged) {
      console.log(`  - original: ${t.answer.slice(0, 200).replace(/\s+/g, " ")}`);
      console.log(`  + replayed: ${replayed.answer.slice(0, 200).replace(/\s+/g, " ")}`);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
