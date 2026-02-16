import { Box, Text } from "ink";
import { useNavigation } from "../contexts/navigation-context.tsx";

export const HiddenIndicator = () => {
  const { showHidden } = useNavigation();

  if (!showHidden) return null;

  return (
    <Box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="flex-end"
      alignItems="flex-start"
      padding={0}
    >
      <Text color="red">[HIDDEN TODOS VISIBLE]</Text>
    </Box>
  );
};
