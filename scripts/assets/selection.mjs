export function selectByScoreAndDiversity(eligible, { maxDownloads, maxSimilar = 2 }) {
  const selected = [];
  const rejected = [];
  const sorted = [...eligible].sort((left, right) => right.totalScore - left.totalScore);
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
