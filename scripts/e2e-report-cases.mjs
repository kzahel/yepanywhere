export function* e2eReportCases(suites, file) {
  for (const suite of suites ?? []) {
    const suiteFile = suite.file || file;
    yield* e2eReportCases(suite.suites, suiteFile);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        yield { spec, test, file: spec.file || suiteFile };
      }
    }
  }
}
