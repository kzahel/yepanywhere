import { appendFileSync, readFileSync } from "node:fs";
import { e2eReportCases } from "./e2e-report-cases.mjs";

const [reportPath, shard] = process.argv.slice(2);
const lines = [`### Browser first-attempt results (${shard})`, ""];

function inlineCode(value) {
  const text = String(value).replaceAll("`", "'").replace(/\s+/g, " ");
  return `\`${text}\``;
}

try {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const { expected, flaky, skipped, unexpected } = report.stats;
  lines.push(
    `- Passed on the first attempt or matched the expected outcome: ${expected}`,
    `- Passed after a retry: ${flaky}`,
    `- Failed overall: ${unexpected}`,
    `- Skipped or did not run: ${skipped}`,
  );
  if (report.errors?.length) {
    lines.push(`- Errors outside a test case: ${report.errors.length}`);
  }

  for (const { spec, test, file } of e2eReportCases(report.suites)) {
    if (test.status !== "flaky" && test.status !== "unexpected") continue;
    const outcome = test.status === "flaky" ? "Passed on retry" : "Failed";
    const attempts = test.results.map(({ status }) => status).join(" → ");
    const project = test.projectName
      ? ` [${inlineCode(test.projectName)}]`
      : "";
    lines.push(
      `- **${outcome}** · ${inlineCode(`${file}:${spec.line}`)} ${inlineCode(spec.title)}${project} (${attempts})`,
    );
  }
} catch (error) {
  lines.push(
    error.code === "ENOENT"
      ? "No Playwright report was produced. See the shard log for setup or runner failures."
      : "Playwright report could not be read. See the shard log and report artifact.",
  );
}

const markdown = `${lines.join("\n")}\n\n`;
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
} else {
  process.stdout.write(markdown);
}
