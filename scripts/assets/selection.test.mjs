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
console.log("selection tests passed");
