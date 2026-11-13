import { Box, Text } from "ink";
import { memo } from "react";
import { COLORS } from "../theme/colors.ts";

export const TodoListScrollbar = memo(
  ({
    totalRows,
    listHeight,
    offsetRow,
  }: {
    totalRows: number;
    listHeight: number;
    offsetRow: number;
  }) => {
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
    const handleTop =
      maxOffset === 0
        ? 0
        : Math.floor((clampedOffset / maxOffset) * handleTravel);

    // One text node with newlines renders the track in a single pass. Building
    // it from one <Text> per row made every list navigation reconcile and
    // re-render the whole scrollbar, even when the handle did not move.
    let track = "";
    for (let row = 0; row < trackHeight; row++) {
      const inHandle = row >= handleTop && row < handleTop + handleHeight;
      track += (inHandle ? "│" : " ") + (row === trackHeight - 1 ? "" : "\n");
    }

    return (
      <Box flexDirection="column">
        <Text color={COLORS.muted}>{track}</Text>
      </Box>
    );
  },
);

TodoListScrollbar.displayName = "TodoListScrollbar";
