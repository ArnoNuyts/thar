import { Box, Text } from "ink";
import { SECONDARY_COLOR } from "../constants.ts";

export const SELECTED_MARKER = "» ";
export const UNSELECTED_MARKER = "  ";

export interface SelectListItem {
  /** Stable identity for React keys; also keeps the row order explicit. */
  key: string;
  label: string;
}

interface SelectListProps {
  items: readonly SelectListItem[];
  selectedIndex: number;
  paddingX?: number;
}

/** Shared highlighted list used by the date, recurrence, and priority modals. */
export const SelectList = ({
  items,
  selectedIndex,
  paddingX = 1,
}: SelectListProps) => {
  return (
    <Box flexDirection="column" paddingX={paddingX}>
      {items.map((item, index) => {
        const isSelected = index === selectedIndex;
        return (
          <Box key={item.key}>
            <Text color={SECONDARY_COLOR}>
              {isSelected ? SELECTED_MARKER : UNSELECTED_MARKER}
            </Text>
            <Text wrap="truncate">{item.label}</Text>
          </Box>
        );
      })}
    </Box>
  );
};
