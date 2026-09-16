export function selectByScoreAndDiversity(eligible, { maxDownloads, maxSimilar = 2 }) {
  const selected = [];
  const rejected = [];
  const classified = [];
  for (const item of eligible) {
    if (!item.classification || !item.classification.role || !item.destination || !item.destination.finalCategory) {
      rejected.push({ ...item, rejectionReason: "missing_classification" });
      continue;
    }
    classified.push(item);
  }
  const sorted = classified.sort((left, right) => right.totalScore - left.totalScore);
  for (const item of sorted) {
    if (selected.length >= maxDownloads) break;
    const similar = selected.filter((chosen) =>
      chosen.query.text === item.query.text &&
      chosen.classification.role === item.classification.role &&
      chosen.destination.finalCategory === item.destination.finalCategory
    );
    if (similar.length >= maxSimilar) rejected.push({ ...item, rejectionReason: "diversity_limit" });
    else selected.push(item);
  }
  return { selected, rejected };
}
