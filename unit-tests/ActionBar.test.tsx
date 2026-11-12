import { expect, test } from "vitest";
import { render } from "ink-testing-library";

import { Box } from "ink";
import { ActionBar } from "../components/ActionBar.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useEffect } from "react";
import { SearchProvider } from "../contexts/search-context.tsx";
import { waitFor } from "./test-utils.ts";
import { TestWrapper } from "./test-components.tsx";

const ActionBarTestWrapper = ({ children }: { children: React.ReactNode }) => (
  <TestWrapper>
    <SearchProvider>{children}</SearchProvider>
  </TestWrapper>
);

test("ActionBar: should render action items", async () => {
  const { unmount, lastFrame } = render(
    <ActionBarTestWrapper>
      <ActionBar />
    </ActionBarTestWrapper>,
  );

  await waitFor(() => {
    const frame = lastFrame() || "";
    expect(frame).toMatch(/Menu/);
    expect(frame).toMatch(/Quit/);
    expect(frame).toMatch(/New/);
    expect(frame).toMatch(/Edit/);
    expect(frame).toMatch(/Search/);
  });

  unmount();
});

test("ActionBar: should render toaster message", async () => {
  const TestComponent = () => {
    const { showToaster } = useToaster();
    useEffect(() => {
      showToaster("Test toast notification");
    }, [showToaster]);

    return <ActionBar />;
  };

  const { unmount, lastFrame } = render(
    <ActionBarTestWrapper>
      <TestComponent />
    </ActionBarTestWrapper>,
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Test toast notification/);
  });

  unmount();
});

test("ActionBar: mouse click on 'n New' opens create-todo modal", async () => {
  let activeModalName: string | null = null;

  const Observer = () => {
    const { activeModal } = useModal();
    activeModalName = activeModal;
    return <ActionBar />;
  };

  const { unmount, stdin } = render(
    <ActionBarTestWrapper>
      <Box flexDirection="column" height={24}>
        <Observer />
      </Box>
    </ActionBarTestWrapper>,
  );

  // In ink-testing-library default rows=24.
  // ACTION_ITEMS:
  // " x Menu  " (start: 1, end: 10)
  // " q Quit  " (start: 11, end: 20)
  // " n New  " (start: 21, end: 29) -> x=25, y=24
  stdin.write("\x1b[<0;25;24M");

  await waitFor(() => expect(activeModalName).toEqual("create-todo"));

  unmount();
});

test("ActionBar: shows a persistent read-only indicator", async () => {
  const { unmount, lastFrame } = render(
    <TestWrapper todoValue={{ readOnly: true }}>
      <SearchProvider>
        <ActionBar />
      </SearchProvider>
    </TestWrapper>,
  );

  try {
    await waitFor(() => {
      expect(lastFrame() ?? "").toMatch(/READ-ONLY/);
    });
  } finally {
    unmount();
  }
});
