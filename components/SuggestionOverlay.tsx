import { Box, Text } from "ink";
import { useSuggestion } from "../contexts/suggestion-context.tsx";

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
      borderColor="yellow"
      position="absolute"
      marginTop={position.top}
      marginLeft={position.left}
      backgroundColor="black"
      minWidth={suggestionMaxLenth + 4} // +4 for padding/border/prefix
    >
      {suggestions.map((suggestion, index) => (
        <Text
          key={suggestion}
          color={index === selectedIndex ? "blue" : "white"}
          backgroundColor={index === selectedIndex ? "white" : undefined}
          wrap="truncate-end"
        >
          {type === "project" ? "+" : "@"}
          {suggestion}
        </Text>
      ))}
    </Box>
  );
};
