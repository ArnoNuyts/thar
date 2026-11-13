import { Text } from "ink";
import { formatUpdateBadge } from "../logic/update-badge.ts";
import { COLORS } from "../theme/colors.ts";

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
