export function getSuccessfulSubmissionActivity(submissions) {
  const activity = {};

  for (const submission of submissions) {
    if (
      String(submission.status).toUpperCase() !== "ACCEPTED" ||
      submission.totalCount <= 0 ||
      submission.passedCount !== submission.totalCount
    ) {
      continue;
    }

    const date = new Date(submission.createdAt);
    if (Number.isNaN(date.getTime())) continue;

    const day = date.toISOString().slice(0, 10);
    activity[day] = (activity[day] || 0) + 1;
  }

  return activity;
}
