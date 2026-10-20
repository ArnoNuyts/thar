import { Box, measureElement, Text } from "ink";
import { ReactNode, useLayoutEffect, useRef } from "react";
import { COLORS } from "../theme/colors.ts";

interface ModalProps {
  children?: ReactNode;
  title?: string;
  width?: number | string;
  onLayoutSizeChange?: (size: { columns: number; rows: number }) => void;
}

export const Modal = (
  { children, title, width = "50%", onLayoutSizeChange }: ModalProps,
) => {
  const containerRef = useRef(null);
  const lastLayoutRef = useRef<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const { width, height } = measureElement(containerRef.current);
    if (width > 0 && height > 0) {
      if (
        lastLayoutRef.current?.width === width &&
        lastLayoutRef.current?.height === height
      ) {
        return;
      }
      lastLayoutRef.current = { width, height };
      onLayoutSizeChange?.({ columns: width, rows: height });
    }
  });

  return (
    <Box
      position="absolute"
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
      ref={containerRef}
    >
      <Box
        flexDirection="column"
        width={width}
        padding={1}
        backgroundColor={COLORS.background}
      >
        {title && (
          <Box
            borderStyle="bold"
            borderColor={COLORS.primary}
            borderLeft
            borderRight={false}
            borderBottom={false}
            borderTop={false}
          >
            <Text
              color={COLORS.inverseForeground}
              backgroundColor={COLORS.primary}
            >
              {` ${title} `}
            </Text>
          </Box>
        )}
        <Box
          borderStyle="bold"
          borderColor={COLORS.primary}
          borderLeft
          borderRight={false}
          borderBottom={false}
          borderTop={false}
          padding={1}
          flexDirection="column"
          backgroundColor={COLORS.background}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
};
