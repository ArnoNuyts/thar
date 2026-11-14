import { Box, Text } from "ink";
import {
  Children,
  cloneElement,
  isValidElement,
  ReactElement,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { COLORS } from "../theme/colors.ts";
import { useInput } from "../hooks/useInput.ts";

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  isSelected?: boolean;
  isHovered?: boolean;
}

interface ButtonGroupProps {
  children: ReactNode;
  isFocused: boolean;
  selectedIndex?: number;
  defaultSelectedIndex?: number;
  onSelectedIndexChange?: (index: number) => void;
  hoveredIndex?: number | null;
  spacing?: number;
  equalWidth?: boolean;
}

type ButtonComponent = ((props: ButtonProps) => ReactElement) & {
  Group: (props: ButtonGroupProps) => ReactElement;
};

const ButtonBase = ({
  label,
  isSelected = false,
  isHovered = false,
}: ButtonProps) => (
  <Text
    bold={isSelected || isHovered}
    color={
      isHovered ? COLORS.warning : isSelected ? COLORS.white : COLORS.modalMuted
    }
  >
    {isSelected || isHovered ? `« ${label} »` : `‹ ${label} ›`}
  </Text>
);

const ButtonGroup = ({
  children,
  isFocused,
  selectedIndex,
  defaultSelectedIndex = 0,
  onSelectedIndexChange,
  hoveredIndex,
  spacing = 2,
  equalWidth = false,
}: ButtonGroupProps) => {
  const buttonChildren = useMemo(
    () =>
      Children.toArray(children).filter(
        (child): child is ReactElement<ButtonProps> =>
          isValidElement<ButtonProps>(child),
      ),
    [children],
  );

  const [internalIndex, setInternalIndex] = useState(defaultSelectedIndex);
  const isControlled = selectedIndex !== undefined;
  const requestedIndex = isControlled ? selectedIndex : internalIndex;
  // Clamp during render so a shrinking child list cannot leave the selection
  // pointing past the last button.
  const lastIndex = Math.max(0, buttonChildren.length - 1);
  const activeIndex = Math.min(Math.max(requestedIndex, 0), lastIndex);
  const activeIndexRef = useRef(activeIndex);

  useLayoutEffect(() => {
    activeIndexRef.current = activeIndex;
  });

  useEffect(() => {
    if (activeIndex === requestedIndex) return;
    // A controlled parent needs to hear that its index was clamped. The
    // uncontrolled index is left alone so growing the list restores it.
    onSelectedIndexChange?.(activeIndex);
  }, [activeIndex, requestedIndex, onSelectedIndexChange]);

  const setIndex = (next: number) => {
    if (buttonChildren.length === 0) return;
    const max = buttonChildren.length - 1;
    const bounded = Math.max(0, Math.min(max, next));
    activeIndexRef.current = bounded;
    if (!isControlled) setInternalIndex(bounded);
    onSelectedIndexChange?.(bounded);
  };

  const moveIndex = (delta: number) => {
    if (buttonChildren.length === 0) return;
    const wrapped =
      (activeIndex + delta + buttonChildren.length) % buttonChildren.length;
    setIndex(wrapped);
  };

  const activateIndex = (index: number) => {
    if (index < 0 || index >= buttonChildren.length) return;
    buttonChildren[index].props.onPress?.();
  };

  useInput(
    (input, key) => {
      if (key.tab) {
        moveIndex(key.shift ? -1 : 1);
        return;
      }

      if (key.leftArrow) {
        moveIndex(-1);
        return;
      }

      if (key.rightArrow) {
        moveIndex(1);
        return;
      }

      if (key.return || input === " ") {
        const candidate = hoveredIndex ?? activeIndexRef.current;
        activateIndex(candidate);
      }
    },
    { isActive: isFocused },
  );

  return (
    <Box width="100%" justifyContent="center">
      {buttonChildren.map((button, index) => (
        <Box
          key={button.key ?? button.props.label}
          marginRight={index < buttonChildren.length - 1 ? spacing : 0}
          flexGrow={equalWidth ? 1 : 0}
          justifyContent={equalWidth ? "center" : undefined}
        >
          {cloneElement(button, {
            isSelected: index === activeIndex,
            isHovered: hoveredIndex === index,
          })}
        </Box>
      ))}
    </Box>
  );
};

export const Button = ButtonBase as ButtonComponent;
Button.Group = ButtonGroup;
