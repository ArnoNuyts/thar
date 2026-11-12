import { Box } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { expect, test } from "vitest";

import { ActionBar } from "../components/ActionBar.tsx";
import { formatUpdateBadge } from "../components/UpdateBadge.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
import { UpdateProvider } from "../contexts/update-context.tsx";
import { waitFor } from "./test-utils.ts";
import { TestWrapper } from "./test-components.tsx";

const npmDescriptor = {
  scriptPath: "/usr/local/lib/node_modules/todotui/dist/main.js",
  env: {},
  platform: "linux" as const,
};

const UpdateTestWrapper = ({
  children,
  status = "available",
  latestVersion = "0.5.0",
}: {
  children: React.ReactNode;
  status?: "available" | "up-to-date" | "idle";
  latestVersion?: string;
}) => (
  <TestWrapper>
    <SearchProvider>
      <UpdateProvider
        options={{
          enabled: false,
          currentVersion: "0.4.0",
          initialState: { status, latestVersion },
          installDescriptor: npmDescriptor,
        }}
      >
        {children}
      </UpdateProvider>
    </SearchProvider>
  </TestWrapper>
);

test("update-badge: formats and truncates for narrow widths", () => {
  expect(formatUpdateBadge("0.5.0", 40)).toEqual("↑ v0.5.0 · u update");
  expect(formatUpdateBadge("0.5.0", 19)).toEqual("↑ v0.5.0 · u update");
  expect(formatUpdateBadge("0.5.0", 18)).toEqual("↑ v0.5.0");
  expect(formatUpdateBadge("0.5.0", 7)).toEqual("↑");
  expect(formatUpdateBadge("0.5.0", 1)).toEqual("↑");
  expect(formatUpdateBadge("0.5.0", 0)).toEqual("");
  expect(formatUpdateBadge(undefined, 40)).toEqual("");
});

test("update-badge: ActionBar shows the available update", async () => {
  const { unmount, lastFrame } = render(
    <UpdateTestWrapper>
      <ActionBar />
    </UpdateTestWrapper>,
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/↑ v0\.5\.0 · u update/);
  });

  unmount();
});

test("update-badge: ActionBar hides the badge when no update is available", async () => {
  const { unmount, lastFrame } = render(
    <UpdateTestWrapper status="up-to-date">
      <ActionBar />
    </UpdateTestWrapper>,
  );

  await waitFor(() => {
    expect(lastFrame() || "").toMatch(/Menu/);
  });
  expect(lastFrame() || "").not.toMatch(/u update/);

  unmount();
});

test("update-badge: a transient toast takes priority over the badge", async () => {
  const Toast = () => {
    const { showToaster } = useToaster();
    useEffect(() => {
      showToaster("Saved");
    }, [showToaster]);
    return null;
  };

  const { unmount, lastFrame } = render(
    <UpdateTestWrapper>
      <Box flexDirection="column" height={24}>
        <Toast />
        <ActionBar />
      </Box>
    </UpdateTestWrapper>,
  );

  await waitFor(() => {
    const frame = lastFrame() || "";
    expect(frame).toMatch(/Saved/);
    expect(frame).not.toMatch(/u update/);
  });

  unmount();
});

test("update-badge: clicking the badge opens the update modal", async () => {
  let activeModalName: string | null = null;

  const Observer = () => {
    const { activeModal } = useModal();
    activeModalName = activeModal;
    return <ActionBar />;
  };

  const { unmount, stdin } = render(
    <UpdateTestWrapper>
      <Box flexDirection="column" height={24}>
        <Observer />
      </Box>
    </UpdateTestWrapper>,
  );

  await waitFor(() => {
    expect(activeModalName).toBeNull();
  });

  // ink-testing-library uses 100 columns. The 19-character badge starts at x=82
  // on the footer row (y=24).
  stdin.write("\x1b[<0;90;24M");

  await waitFor(() => expect(activeModalName).toEqual("update-modal"));

  unmount();
});
