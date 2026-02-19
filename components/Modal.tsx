import { Box, Text } from "ink";
import { ReactNode } from "react";
import { PRIMARY_COLOR } from "../constants.ts";
import { COLORS } from "../theme/colors.ts";

interface ModalProps {
  children?: ReactNode;
  isFocused?: boolean;
  title?: string;
  width?: number | string;
}

export const Modal = (
  { children, title, width = "50%" }: ModalProps,
) => {
  return (
    <Box
      position="absolute"
      width="100%"
      height="100%"
      alignItems="center"
      justifyContent="center"
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
            borderColor={PRIMARY_COLOR}
            borderLeft
            borderRight={false}
            borderBottom={false}
            borderTop={false}
          >
            <Text
              color={COLORS.inverseForeground}
              backgroundColor={PRIMARY_COLOR}
            >
              {` ${title} `}
            </Text>
          </Box>
        )}
        <Box
          borderStyle="bold"
          borderColor={PRIMARY_COLOR}
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
