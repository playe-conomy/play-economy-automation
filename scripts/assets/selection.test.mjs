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

const limitedCandidates = selectByScoreAndDiversity([
  eligible("strong cover", 180),
  eligible("strong controller", 170),
  { ...eligible("strong promotional art", 160), query: { text: "Guitar Hero official promotional artwork" }, classification: { role: "official_art" } }
], { maxDownloads: 5, maxSimilar: 5 });
assert.deepEqual(limitedCandidates.selected.map((item) => item.candidate.title), ["strong cover", "strong controller", "strong promotional art"]);
assert.equal(limitedCandidates.selected.length, 3);
console.log("selection tests passed");
