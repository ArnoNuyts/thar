import { Box, Text, useApp, useWindowSize } from "ink";
import { Fragment, memo } from "react";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useSearch } from "../contexts/search-context.tsx";
import { navigationSelectedTodoRef } from "../contexts/navigation-context.tsx";
import { useMouseInput } from "../hooks/useMouseInput.ts";
import { COLORS } from "../theme/colors.ts";

const ACTION_ITEMS = [
  { key: "x", text: "Menu" },
  { key: "q", text: "Quit" },
  { key: "n", text: "New" },
  { key: "e", text: "Edit" },
  { key: "/", text: "Search" },
] as const;

export const ActionBar = memo(() => {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const { toasterMessage } = useToaster();
  const { openModal, activeModal } = useModal();
  const { focusRef } = useSearch();

  useMouseInput((event) => {
    if (!event.leftClick || event.x === undefined || event.y === undefined) {
      return;
    }
    if (activeModal) return;

    const contentRow = rows;
    if (event.y !== contentRow) return;

    let x = 1;
    for (const item of ACTION_ITEMS) {
      const segment = ` ${item.key} ${item.text}  `;
      const start = x;
      const end = x + segment.length - 1;
      if (event.x >= start && event.x <= end) {
        switch (item.key) {
          case "x":
            openModal("todo-menu");
            return;
          case "q":
            exit();
            return;
          case "n":
            openModal("create-todo");
            return;
          case "e":
            if (navigationSelectedTodoRef.current) {
              openModal("edit-todo", navigationSelectedTodoRef.current);
            }
            return;
          case "/":
            focusRef.current?.();
            return;
        }
      }
      x += segment.length;
    }
  });

  return (
    <Box
      height={2}
      borderStyle="single"
      borderTop
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      borderTopDimColor
      borderColor={COLORS.foreground}
      backgroundColor={COLORS.background}
      justifyContent="space-between"
    >
      <Box>
        {ACTION_ITEMS.map((item) => {
          return (
            <Fragment key={item.key}>
              <Text color={COLORS.primary}>{` ${item.key}`}</Text>
              <Text>{` ${item.text}  `}</Text>
            </Fragment>
          );
        })}
      </Box>
      {toasterMessage && (
        <Box padding={0}>
          <Text color={COLORS.secondary}>{toasterMessage}</Text>
        </Box>
      )}
    </Box>
  );
});

ActionBar.displayName = "ActionBar";
