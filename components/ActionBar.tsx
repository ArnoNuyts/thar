import { Box, Text } from "ink";
import React, { Fragment, useEffect, useState } from "react";
import { useTodo } from "../contexts/todo-context.tsx";

export const ActionBar = () => {
  const { lastReloaded } = useTodo();
  const [showFlash, setShowFlash] = useState(false);

  useEffect(() => {
    if (lastReloaded) {
      setShowFlash(true);
      const timer = setTimeout(() => {
        setShowFlash(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [lastReloaded]);

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
      {showFlash && (
        <Box>
          <Text color="green">File reloaded</Text>
        </Box>
      )}
    </Box>
  );
};
