import { Box, Text } from "ink";
import { ReactNode } from "react";

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
      <Box flexDirection="column" width={width}>
        {title && (
          <Text color="black" backgroundColor="yellow">{` ${title} `}</Text>
        )}
        <Box
          borderStyle="double"
          borderColor="yellow"
          flexDirection="column"
          backgroundColor="black"
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
};
