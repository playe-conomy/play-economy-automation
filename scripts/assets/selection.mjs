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
  const comparison = (left, right) => {
    const leftExactForm = Number(Boolean(left.query?.preferred_editorial_form) && left.editorialForm === left.query.preferred_editorial_form && (!left.query.target_entity || left.classification?.entity === left.query.target_entity));
    const rightExactForm = Number(Boolean(right.query?.preferred_editorial_form) && right.editorialForm === right.query.preferred_editorial_form && (!right.query.target_entity || right.classification?.entity === right.query.target_entity));
    const comparisons = [
      rightExactForm - leftExactForm,
      (right.scored?.semantic?.score ?? 0) - (left.scored?.semantic?.score ?? 0),
      (right.visualUtility?.score ?? 0) - (left.visualUtility?.score ?? 0),
      (right.scored?.quality?.score ?? 0) - (left.scored?.quality?.score ?? 0),
      right.totalScore - left.totalScore
    ];
    return comparisons.find((value) => value !== 0) ?? String(left.candidate?.id ?? left.candidate?.sourceUrl ?? left.candidate?.title ?? "").localeCompare(String(right.candidate?.id ?? right.candidate?.sourceUrl ?? right.candidate?.title ?? ""));
  };
  const sorted = [...classified].sort(comparison);
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
