import { Box } from "ink";
import { render } from "ink-testing-library";
import { useEffect } from "react";
import { expect, test } from "vitest";

import { UpdateModal } from "../components/UpdateModal.tsx";
import { useModal } from "../contexts/modal-context.tsx";
import {
  UpdateProvider,
  useUpdate,
  type UpdateContextType,
} from "../contexts/update-context.tsx";
import {
  clearPendingUpdate,
  peekPendingUpdate,
} from "../logic/pending-update.ts";
import { waitFor } from "./test-utils.ts";
import { TestWrapper } from "./test-components.tsx";

const npmDescriptor = {
  scriptPath: "/usr/local/lib/node_modules/todotui/dist/main.js",
  env: {},
  platform: "linux" as const,
};

const npxDescriptor = {
  scriptPath: "/home/me/.npm/_npx/123/node_modules/todotui/dist/main.js",
  env: {},
  platform: "linux" as const,
};

const Harness = ({
  onUpdate,
}: {
  onUpdate?: (value: UpdateContextType) => void;
}) => {
  const { activeModal, openModal } = useModal();

  useEffect(() => {
    openModal("update-modal");
  }, [openModal]);

  const Probe = () => {
    const value = useUpdate();
    useEffect(() => {
      onUpdate?.(value);
    });
    return null;
  };

  return (
    <Box flexDirection="column" height={24} width={101}>
      <Probe />
      {activeModal === "update-modal" && <UpdateModal />}
    </Box>
  );
};

const renderModal = (
  descriptor: typeof npmDescriptor | typeof npxDescriptor = npmDescriptor,
  onUpdate?: (value: UpdateContextType) => void,
) =>
  render(
    <TestWrapper>
      <Box flexDirection="column" height={24} width={101}>
        <UpdateProvider
          options={{
            enabled: false,
            currentVersion: "0.4.0",
            initialState: { status: "available", latestVersion: "0.5.0" },
            installDescriptor: descriptor,
          }}
        >
          <Harness onUpdate={onUpdate} />
        </UpdateProvider>
      </Box>
    </TestWrapper>,
  );

test("update-modal: shows versions, install command and release notes", async () => {
  const { unmount, lastFrame } = renderModal();

  await waitFor(() => {
    const frame = lastFrame() || "";
    expect(frame).toMatch(/Update available/);
    expect(frame).toMatch(/0\.4\.0/);
    expect(frame).toMatch(/0\.5\.0/);
    expect(frame).toMatch(/npm install -g @arnoarnoarno\/thar@latest/);
    expect(frame).toMatch(/Release notes:/);
    expect(frame).toMatch(/releases\/tag\/v0\.5\.0/);
    expect(frame).toMatch(/Update now/);
    expect(frame).toMatch(/Later/);
    expect(frame).toMatch(/Skip this version/);
  });

  unmount();
});

test("update-modal: Esc closes the modal", async () => {
  const { unmount, lastFrame, stdin } = renderModal();
  await waitFor(() => expect(lastFrame() || "").toMatch(/Update available/));

  stdin.write("\x1b");

  await waitFor(() => {
    expect(lastFrame() || "").not.toMatch(/Update available/);
  });

  unmount();
});

test("update-modal: Later closes the modal without changing anything", async () => {
  let latest: UpdateContextType | undefined;
  const { unmount, lastFrame, stdin } = renderModal(npmDescriptor, (value) => {
    latest = value;
  });
  await waitFor(() => expect(lastFrame() || "").toMatch(/Update available/));

  stdin.write("\t");
  await waitFor(() => expect(lastFrame() || "").toMatch(/« Later »/));
  stdin.write("\r");

  await waitFor(() => {
    expect(lastFrame() || "").not.toMatch(/Update available/);
  });
  expect(latest?.skippedVersion).toBeUndefined();
  expect(peekPendingUpdate()).toBeUndefined();

  unmount();
});

test("update-modal: Skip this version hides the badge for that version", async () => {
  let latest: UpdateContextType | undefined;
  const { unmount, lastFrame, stdin } = renderModal(npmDescriptor, (value) => {
    latest = value;
  });
  await waitFor(() => expect(lastFrame() || "").toMatch(/Update available/));

  stdin.write("\t");
  await waitFor(() => expect(lastFrame() || "").toMatch(/« Later »/));
  stdin.write("\t");
  await waitFor(() =>
    expect(lastFrame() || "").toMatch(/« Skip this version »/),
  );
  stdin.write("\r");

  await waitFor(() => {
    expect(latest?.skippedVersion).toEqual("0.5.0");
    expect(latest?.isUpdateAvailable).toEqual(false);
  });

  unmount();
});

test("update-modal: Update now records a pending update and exits", async () => {
  clearPendingUpdate();
  const { unmount, lastFrame, stdin } = renderModal();
  await waitFor(() => expect(lastFrame() || "").toMatch(/Update available/));

  stdin.write("\r");

  await waitFor(() => {
    const pending = peekPendingUpdate();
    expect(pending?.version).toEqual("0.5.0");
    expect(pending?.command.command).toEqual("npm");
    expect(pending?.command.args).toEqual([
      "install",
      "-g",
      "@arnoarnoarno/thar@latest",
    ]);
  });

  clearPendingUpdate();
  unmount();
});

test("update-modal: ephemeral installs show the exact command and no self-update button", async () => {
  const { unmount, lastFrame } = renderModal(npxDescriptor);

  await waitFor(() => {
    const frame = lastFrame() || "";
    expect(frame).toMatch(/npx @arnoarnoarno\/thar@latest/);
    expect(frame).not.toMatch(/Update now/);
    expect(frame).toMatch(/Later/);
    expect(frame).toMatch(/Skip this version/);
  });

  unmount();
});

test("update-modal: resolves an unknown install only when opened", async () => {
  let lookups = 0;

  const { unmount, lastFrame } = render(
    <TestWrapper>
      <Box flexDirection="column" height={24} width={101}>
        <UpdateProvider
          options={{
            enabled: false,
            currentVersion: "0.4.0",
            initialState: { status: "available", latestVersion: "0.5.0" },
            installDescriptor: {
              scriptPath: "/opt/custom/todotui/dist/main.js",
              env: {},
              platform: "linux",
            },
            globalRootLookup: async () => {
              lookups++;
              return "/opt/custom";
            },
          }}
        >
          <Harness />
        </UpdateProvider>
      </Box>
    </TestWrapper>,
  );

  await waitFor(() => {
    const frame = lastFrame() || "";
    expect(lookups).toEqual(1);
    expect(frame).toMatch(/npm \(global\)/);
    expect(frame).toMatch(/Update now/);
  });

  unmount();
});
