import { Box, Text } from "ink";
import { useSuggestion } from "../contexts/suggestion-context.tsx";
import { COLORS } from "../theme/colors.ts";

export const SuggestionOverlay = () => {
  const { suggestions, selectedIndex, type, position } = useSuggestion();

  if (suggestions.length === 0) {
    return null;
  }

  const suggestionMaxLenth = suggestions.reduce((max, suggestion) => {
    return Math.max(max, suggestion.length);
  }, 0);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={COLORS.primary}
      position="absolute"
      marginTop={position.top}
      marginLeft={position.left}
      backgroundColor={COLORS.background}
      minWidth={suggestionMaxLenth + 4} // +4 for padding/border/prefix
    >
      {suggestions.map((suggestion, index) => (
        <Text
          key={suggestion}
          color={index === selectedIndex
            ? COLORS.accentBlue
            : COLORS.foreground}
          backgroundColor={index === selectedIndex
            ? COLORS.inverseBackground
            : undefined}
          wrap="truncate-end"
        >
          {" "}
          {type === "project" ? "+" : "@"}
          {suggestion.padEnd(suggestionMaxLenth + 1, " ")}
        </Text>
      ))}
    </Box>
  );
};
