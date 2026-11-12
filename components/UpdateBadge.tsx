import { Text } from "ink";
import { COLORS } from "../theme/colors.ts";

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

export const UpdateBadge = ({
  latest,
  availableWidth,
}: {
  latest: string | undefined;
  availableWidth: number;
}) => {
  const text = formatUpdateBadge(latest, availableWidth);
  if (!text) return null;

  return <Text color={COLORS.warning}>{text}</Text>;
};
