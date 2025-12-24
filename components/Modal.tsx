import { Box, Text } from "ink";
import { ReactNode } from "react";
import { PRIMARY_COLOR } from "../constants.ts";

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
        backgroundColor="black"
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
            <Text color="black" backgroundColor="yellow">{` ${title} `}</Text>
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
          backgroundColor="#000"
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
};
