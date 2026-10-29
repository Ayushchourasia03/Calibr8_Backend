import assert from "node:assert/strict";
import {
  getSolvedUserCounts,
  syncProblemSolvedCount,
} from "../src/utils/problemSolvedCount.js";

const counts = getSolvedUserCounts([
  {
    problemId: "problem-1",
    userId: "user-1",
    status: "ACCEPTED",
    passedCount: 5,
    totalCount: 5,
  },
  {
    problemId: "problem-1",
    userId: "user-1",
    status: "ACCEPTED",
    passedCount: 5,
    totalCount: 5,
  },
  {
    problemId: "problem-1",
    userId: "user-2",
    status: "accepted",
    passedCount: 4,
    totalCount: 5,
  },
  {
    problemId: "problem-1",
    userId: "user-3",
    status: "WRONG_ANSWER",
    passedCount: 5,
    totalCount: 5,
  },
  {
    problemId: "problem-2",
    userId: null,
    status: "ACCEPTED",
    passedCount: 3,
    totalCount: 3,
  },
  {
    problemId: "problem-3",
    userId: "user-4",
    status: "ACCEPTED",
    passedCount: 0,
    totalCount: 0,
  },
]);

assert.deepEqual([...counts], [["problem-1", 1]]);

let updatedProblem;
const solvedCount = await syncProblemSolvedCount(
  {
    submission: {
      findMany: async () => [
        {
          problemId: "problem-4",
          userId: "user-1",
          status: "ACCEPTED",
          passedCount: 2,
          totalCount: 2,
        },
        {
          problemId: "problem-4",
          userId: "user-1",
          status: "ACCEPTED",
          passedCount: 2,
          totalCount: 2,
        },
        {
          problemId: "problem-4",
          userId: "user-2",
          status: "ACCEPTED",
          passedCount: 1,
          totalCount: 2,
        },
      ],
    },
    problem: {
      update: async (args) => {
        updatedProblem = args;
      },
    },
  },
  "problem-4",
);
assert.equal(solvedCount, 1);
assert.deepEqual(updatedProblem, {
  where: { id: "problem-4" },
  data: { solvedCount: 1 },
});

console.log("Problem solved count tests passed.");
