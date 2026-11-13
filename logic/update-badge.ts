export const formatUpdateBadge = (
  latest: string | undefined,
  availableWidth: number,
): string => {
  if (!latest || availableWidth <= 0) return "";

  const full = `↑ v${latest} · u update`;
  if (full.length <= availableWidth) return full;

  const medium = `↑ v${latest}`;
  if (medium.length <= availableWidth) return medium;

  return "↑";
};
