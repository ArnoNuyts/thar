import { Box, Text } from "ink";
import { Fragment } from "react";
import { PRIMARY_COLOR, SECONDARY_COLOR } from "../constants.ts";
import { useToaster } from "../contexts/toaster-context.tsx";

export const ActionBar = () => {
  const { toasterMessage } = useToaster();

  return (
    <Box
      height={2}
      borderStyle="single"
      borderTop
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      borderTopDimColor
      borderColor="white"
      backgroundColor="black"
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
      </Box>
      {toasterMessage && (
        <Box padding={0}>
          <Text color={SECONDARY_COLOR}>{toasterMessage}</Text>
        </Box>
      )}
    </Box>
  );
};
