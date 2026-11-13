import { Box, Text, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";

import { useModal } from "../contexts/modal-context.tsx";
import { useUpdate } from "../contexts/update-context.tsx";
import { useFocusedInput } from "../hooks/useFocusedInput.ts";
import { useMouseInput } from "../hooks/useMouseInput.ts";
import { describeInstallKind } from "../logic/install-method.ts";
import { COLORS } from "../theme/colors.ts";
import { countWrappedLines } from "../utils/modal-layout.ts";
import {
  getModalBodyCellFromClick,
  resolveModalWidth,
} from "../utils/modal-mouse.ts";
import { getTerminalSize } from "../utils/terminal-size.ts";
import { Button } from "./Button.tsx";
import { Modal } from "./Modal.tsx";

const RELEASE_NOTES_BASE = "https://github.com/ArnoNuyts/thar/releases/tag";

export const UpdateModal = () => {
  const { closeModal } = useModal();
  const {
    currentVersion,
    latestVersion,
    installKind,
    updateCommand,
    skipVersion,
    prepareInstall,
    startSelfUpdate,
  } = useUpdate();
  const windowSize = useWindowSize();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [layoutSize, setLayoutSize] = useState<{
    rows?: number;
    columns?: number;
  }>({});

  // Unknown installs are resolved only when the user opens this modal, never
  // during startup.
  useEffect(() => {
    void prepareInstall();
  }, [prepareInstall]);

  const terminalSize = getTerminalSize(windowSize, layoutSize);
  const contentWidth = Math.max(
    1,
    resolveModalWidth(terminalSize.columns, "70%") - 3,
  );

  const releaseNotesUrl = `${RELEASE_NOTES_BASE}/v${latestVersion ?? "latest"}`;
  const content = [
    `Current: v${currentVersion}  →  Latest: v${latestVersion ?? "unknown"}`,
    `Install method: ${describeInstallKind(installKind)}`,
    `Command: ${updateCommand.display}`,
    `Release notes: ${releaseNotesUrl}`,
  ].join("\n");

  const contentRows = useMemo(
    () => countWrappedLines(content, contentWidth),
    [content, contentWidth],
  );
  const buttonRowIndex = contentRows + 1;
  const bodyRows = contentRows + 2;

  const handleSkip = () => {
    skipVersion();
    closeModal();
  };

  const handleUpdate = () => {
    closeModal();
    startSelfUpdate();
  };

  const actions = updateCommand.canSelfUpdate
    ? [
        { label: "Update now", onPress: handleUpdate },
        { label: "Later", onPress: closeModal },
        { label: "Skip this version", onPress: handleSkip },
      ]
    : [
        { label: "Later", onPress: closeModal },
        { label: "Skip this version", onPress: handleSkip },
      ];

  const runAction = (index: number) => {
    actions[index]?.onPress();
  };

  const { isFocused } = useFocusedInput(
    (_input, key) => {
      if (key.escape) closeModal();
    },
    { autoFocus: true, tag: "update-modal" },
  );

  useMouseInput(
    (event) => {
      if (!isFocused) return;
      const currentSize = getTerminalSize(windowSize, layoutSize);
      const bodyCell = getModalBodyCellFromClick(event, currentSize, {
        modalWidth: "70%",
        bodyRows,
      });

      if (!bodyCell || bodyCell.row !== buttonRowIndex) {
        if (event.move) setHoveredIndex(null);
        return;
      }

      const index = Math.min(
        actions.length - 1,
        Math.floor(bodyCell.column / (bodyCell.modalWidth / actions.length)),
      );

      if (event.leftClick) {
        setHoveredIndex(index);
        setSelectedIndex(index);
        runAction(index);
        return;
      }
      setHoveredIndex(index);
    },
    { isActive: isFocused },
  );

  return (
    <Modal
      title="Update available"
      width="70%"
      onLayoutSizeChange={setLayoutSize}
    >
      <Box flexDirection="column">
        <Text>
          {`Current: v${currentVersion}  →  Latest: v${latestVersion ?? "unknown"}`}
        </Text>
        <Text dimColor>
          {`Install method: ${describeInstallKind(installKind)}`}
        </Text>
        <Text wrap="wrap">{`Command: ${updateCommand.display}`}</Text>
        <Text color={COLORS.info} wrap="wrap">
          {`Release notes: ${releaseNotesUrl}`}
        </Text>
        <Box marginTop={1}>
          <Button.Group
            isFocused={isFocused}
            selectedIndex={selectedIndex}
            onSelectedIndexChange={setSelectedIndex}
            hoveredIndex={hoveredIndex}
            equalWidth
          >
            {actions.map((action) => (
              <Button
                key={action.label}
                label={action.label}
                onPress={action.onPress}
              />
            ))}
          </Button.Group>
        </Box>
      </Box>
    </Modal>
  );
};
