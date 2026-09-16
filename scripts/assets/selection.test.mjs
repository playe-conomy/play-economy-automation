import assert from "node:assert/strict";
import { selectByScoreAndDiversity } from "./selection.mjs";

function eligible(title, totalScore) {
  return {
    query: { text: "Guitar Hero controller" },
    classification: { role: "specific" },
    destination: { finalCategory: "Franquicias" },
    candidate: { title },
    totalScore
  };
}

const result = selectByScoreAndDiversity([
  eligible("B", 96),
  eligible("C", 90),
  eligible("A", 114)
], { maxDownloads: 5, maxSimilar: 2 });

assert.deepEqual(result.selected.map((item) => item.candidate.title), ["A", "B"]);
assert.equal(result.rejected[0].candidate.title, "C");

const unclassified = {
  query: { text: "Guitar Hero controller" },
  destination: { finalCategory: "Franquicias" },
  candidate: { title: "missing classification" },
  totalScore: 114
};
const invalidResult = selectByScoreAndDiversity([unclassified], { maxDownloads: 5 });
assert.equal(invalidResult.selected.length, 0);
assert.equal(invalidResult.rejected[0].rejectionReason, "missing_classification");
console.log("selection tests passed");
