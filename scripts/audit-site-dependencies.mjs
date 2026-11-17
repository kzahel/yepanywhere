import { spawnSync } from "node:child_process";

const picomatchAdvisory = "GHSA-fc5q-39xc-vjpf";
const audit = spawnSync("npm", ["audit", "--package-lock-only", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

function hasOnlyExceptedAdvisory(output) {
  try {
    const report = JSON.parse(output);
    if (report.error || report.auditReportVersion !== 2) return false;
    const findings = Object.entries(report.vulnerabilities);
    if (findings.length !== report.metadata.vulnerabilities.total) return false;

    // npm repeats the finding under every affected parent. Parent links are
    // package names. Only advisory objects identify independent findings.
    const advisories = findings.flatMap(([, { via }]) => via);
    const directAdvisories = advisories.filter(
      (item) => typeof item !== "string",
    );
    return (
      directAdvisories.length > 0 &&
      advisories.every((item) =>
        typeof item === "string"
          ? Object.hasOwn(report.vulnerabilities, item)
          : item?.name === "picomatch" &&
            item.url === `https://github.com/advisories/${picomatchAdvisory}`,
      )
    );
  } catch {
    return false;
  }
}

if (audit.error) console.error(audit.error.message);
if (
  audit.status === 1 &&
  !audit.error &&
  hasOnlyExceptedAdvisory(audit.stdout)
) {
  console.log(
    `Website audit passed with documented exception ${picomatchAdvisory}.`,
  );
} else {
  if (audit.stdout) process.stdout.write(audit.stdout);
  process.exitCode = audit.status ?? 1;
}
