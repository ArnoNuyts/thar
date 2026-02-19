import { Box, Text } from "ink";
import { COLORS } from "../theme/colors.ts";

export const TodoListScrollbar = (
  { totalRows, listHeight, offsetRow }: {
    totalRows: number;
    listHeight: number;
    offsetRow: number;
  },
) => {
  const isScrollable = totalRows > listHeight && listHeight > 0;
  if (!isScrollable) return null;

  const trackHeight = listHeight;
  const maxOffset = totalRows - listHeight;
  const handleHeight = Math.max(
    1,
    Math.floor((listHeight / totalRows) * trackHeight),
  );
  const handleTravel = Math.max(0, trackHeight - handleHeight);
  const clampedOffset = Math.max(0, Math.min(offsetRow, maxOffset));
  const handleTop = maxOffset === 0
    ? 0
    : Math.floor((clampedOffset / maxOffset) * handleTravel);

  return (
    <Box flexDirection="column">
      {Array.from({ length: trackHeight }, (_, row) => {
        const inHandle = row >= handleTop && row < handleTop + handleHeight;
        return (
          <Text key={row} color={COLORS.muted}>
            {inHandle ? "|" : " "}
          </Text>
        );
      })}
    </Box>
  );
};
