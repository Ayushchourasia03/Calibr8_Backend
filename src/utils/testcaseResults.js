export function publicTestResults(results) {
  return results.map((testcase) => {
    if (testcase.isVisible) return testcase;

    return {
      testIndex: testcase.testIndex,
      isVisible: false,
      passed: testcase.passed,
      status: testcase.status,
      time: testcase.time,
      memory: testcase.memory,
    };
  });
}
