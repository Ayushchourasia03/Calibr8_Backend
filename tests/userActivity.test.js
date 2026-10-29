import assert from "node:assert/strict";
import { getSuccessfulSubmissionActivity } from "../src/utils/successfulSubmissionActivity.js";

const activity = getSuccessfulSubmissionActivity([
  {
    status: "ACCEPTED",
    passedCount: 3,
    totalCount: 3,
    createdAt: "2026-10-29T10:15:00.000Z",
  },
  {
    status: "accepted",
    passedCount: 3,
    totalCount: 3,
    createdAt: "2026-10-29T12:15:00.000Z",
  },
  {
    status: "ACCEPTED",
    passedCount: 2,
    totalCount: 3,
    createdAt: "2026-10-29T13:15:00.000Z",
  },
  {
    status: "WRONG_ANSWER",
    passedCount: 3,
    totalCount: 3,
    createdAt: "2026-10-29T14:15:00.000Z",
  },
  {
    status: "ACCEPTED",
    passedCount: 0,
    totalCount: 0,
    createdAt: "2026-10-28T14:15:00.000Z",
  },
]);

assert.deepEqual(activity, { "2026-10-29": 2 });
console.log("User activity tests passed.");
