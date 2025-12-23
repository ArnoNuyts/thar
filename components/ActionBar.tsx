import { Box, Text } from "ink";
import { Fragment } from "react";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { PRIMARY_COLOR, SECONDARY_COLOR } from "../constants.ts";

export const ActionBar = () => {
  const { toasterMessage } = useToaster();
  const { showHidden } = useNavigation();

  return (
    <Box
      borderStyle="single"
      borderTop
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      justifyContent="space-between"
    >
      <Box>
        {[
          { key: "x", text: "Menu" },
          { key: "q", text: "Quit" },
          { key: "n", text: "New" },
          { key: "e", text: "Edit" },
          { key: "/", text: "Search" },
        ].map((item) => {
          return (
            <Fragment key={item.key}>
              <Text color={PRIMARY_COLOR}>{` ${item.key}`}</Text>
              <Text>{` ${item.text}  `}</Text>
            </Fragment>
          );
        })}
        {showHidden && <Text color="red">[HIDDEN SHOWN]</Text>}
      </Box>
      {toasterMessage && (
        <Box padding={0}>
          <Text color={SECONDARY_COLOR}>{toasterMessage}</Text>
        </Box>
      )}
    </Box>
  );
};
