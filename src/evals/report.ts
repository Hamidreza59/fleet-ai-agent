/** Markdown rendering and baseline comparison for eval reports. */

import type { EvalReport } from "./types.js";

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export function renderMarkdown(r: EvalReport): string {
  const s = r.summary;
  const lines = [
    `## Eval report - ${r.provider}/${r.model}`,
    "",
    `${s.passed}/${s.cases} cases passed (${pct(s.passRate)}), ${r.trials} trial(s) each. ` +
      `Tokens: ${s.tokens}, cost: $${s.costUsd.toFixed(4)}, latency p50/p95: ${Math.round(s.latencyMsP50)}/${Math.round(s.latencyMsP95)} ms`,
    "",
    "| case | pass | failed scorers | iterations | tokens | latency (ms) |",
    "|---|---|---|---|---|---|",
  ];
  for (const c of r.cases) {
    const n = c.trials.length || 1;
    const avg = (f: (t: (typeof c.trials)[number]) => number) =>
      Math.round(c.trials.reduce((a, t) => a + f(t), 0) / n);
    const pass = c.pass ? "PASS" : c.passRate > 0 ? `FAIL (${pct(c.passRate)})` : "FAIL";
    lines.push(
      `| ${c.id} | ${pass} | ${c.failedScorers.join(", ") || "-"} | ${avg((t) => t.iterations)} | ${avg((t) => t.tokens)} | ${avg((t) => t.latencyMs)} |`,
    );
  }
  lines.push("", "| scorer | pass rate |", "|---|---|");
  for (const [k, v] of Object.entries(s.scorerPassRates)) lines.push(`| ${k} | ${pct(v)} |`);
  return lines.join("\n") + "\n";
}

export function findRegressions(baseline: EvalReport, current: EvalReport): string[] {
  const now = new Map(current.cases.map((c) => [c.id, c]));
  return baseline.cases
    .filter((b) => b.pass)
    .filter((b) => {
      const c = now.get(b.id);
      return c !== undefined && !c.pass;
    })
    .map((b) => b.id);
}

export function baselineSkipReason(baseline: EvalReport, current: EvalReport): string | undefined {
  return baseline.model === current.model
    ? undefined
    : `Baseline model ${baseline.model} != ${current.model}; skipping regression check`;
}
