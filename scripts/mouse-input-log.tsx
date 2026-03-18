import { Box, render, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { useInput } from "../hooks/useInput.ts";
import { useMouseInput } from "../hooks/useMouseInput.ts";

const outputPath = Deno.args[0] ?? "mouse-input.log";

const formatEvent = (
  event: Parameters<typeof useMouseInput>[0] extends (
    e: infer E,
  ) => void ? E
    : never,
) => {
  const timestamp = new Date().toISOString();
  return JSON.stringify({
    timestamp,
    x: event.x,
    y: event.y,
    move: event.move,
    leftClick: event.leftClick,
    wheelUp: event.wheelUp,
    wheelDown: event.wheelDown,
    ctrl: event.raw.ctrl,
    shift: event.raw.shift,
    meta: event.raw.meta,
  });
};

const MouseInputLogger = () => {
  const app = useApp();
  const [eventCount, setEventCount] = useState(0);
  const [lastLine, setLastLine] = useState<string>("(none yet)");
  const writeQueue = useRef(Promise.resolve());

  useEffect(() => {
    writeQueue.current = Deno.writeTextFile(
      outputPath,
      [
        "# Mouse Input Log",
        `# Started: ${new Date().toISOString()}`,
        "# Press q or Esc to stop.",
        "",
      ].join("\n"),
    );
  }, []);

  useMouseInput((event) => {
    const line = formatEvent(event);
    setEventCount((value) => value + 1);
    setLastLine(line);
    writeQueue.current = writeQueue.current.then(() =>
      Deno.writeTextFile(outputPath, `${line}\n`, { append: true })
    );
  }, { isActive: true });

  useInput((input, key) => {
    if (key.escape || input === "q") {
      app.exit();
    }
  }, { isActive: true });

  return (
    <Box flexDirection="column">
      <Text>Mouse logger is active.</Text>
      <Text>{`Writing to: ${outputPath}`}</Text>
      <Text>Move the mouse, hover buttons, click, or use wheel.</Text>
      <Text>Press q or Esc to exit.</Text>
      <Text>{`Captured events: ${eventCount}`}</Text>
      <Text>{`Last event: ${lastLine}`}</Text>
    </Box>
  );
};

render(<MouseInputLogger />);
