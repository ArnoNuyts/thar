import { Box, Text } from "ink";
import React, { Fragment } from "react";

export const ActionBar = () => {
  return (
    <Box
      borderStyle="single"
      borderTop
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
    >
      {[
        { key: "x", text: "Menu" },
        { key: "q", text: "Quit" },
        { key: "n", text: "New" },
        { key: "e", text: "Edit" },
        { key: "a", text: "Archive" },
      ].map((item) => {
        return (
          <Fragment key={item.key}>
            <Text color="yellow">{` ${item.key}`}</Text>
            <Text>{` ${item.text}  `}</Text>
          </Fragment>
        );
      })}
    </Box>
  );
};
