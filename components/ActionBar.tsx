import { Box, Text } from "ink";
import { Fragment } from "react";
import { useToaster } from "../contexts/toaster-context.tsx";

export const ActionBar = () => {
  const { toasterMessage } = useToaster();

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
              <Text color="yellow">{` ${item.key}`}</Text>
              <Text>{` ${item.text}  `}</Text>
            </Fragment>
          );
        })}
      </Box>
      {toasterMessage && (
        <Box padding={0}>
          <Text color="green">{toasterMessage}</Text>
        </Box>
      )}
    </Box>
  );
};
