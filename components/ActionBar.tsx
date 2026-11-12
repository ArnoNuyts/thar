import { Box, Text, useApp, useWindowSize } from "ink";
import { Fragment, memo } from "react";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
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

const ACTION_WIDTH = ACTION_ITEMS.reduce(
  (width, item) => width + ` ${item.key} ${item.text}  `.length,
  0,
);
const READ_ONLY_LABEL = "READ-ONLY";

export const ActionBar = memo(() => {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();
  const { toasterMessage } = useToaster();
  const { readOnly } = useTodo();
  const { openModal, activeModal } = useModal();
  const { focusRef } = useSearch();

  // Keep the transient toast inside the status-bar width, leaving room for
  // the action items and the persistent read-only indicator.
  const indicatorWidth = readOnly ? READ_ONLY_LABEL.length + 2 : 0;
  const toastWidth = Math.max(0, columns - ACTION_WIDTH - indicatorWidth - 1);
  const boundedToast =
    toasterMessage && toastWidth > 0
      ? toasterMessage.slice(0, toastWidth)
      : undefined;

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
      <Box>
        {readOnly && (
          <Box marginRight={1}>
            <Text color={COLORS.danger}>{READ_ONLY_LABEL}</Text>
          </Box>
        )}
        {boundedToast && (
          <Box padding={0}>
            <Text color={COLORS.secondary}>{boundedToast}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
});

ActionBar.displayName = "ActionBar";
