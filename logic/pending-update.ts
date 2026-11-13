import type { InstallCommand } from "./install-method.ts";

export interface PendingUpdate {
  command: InstallCommand;
  version: string;
}

let pendingUpdate: PendingUpdate | undefined;

export const setPendingUpdate = (update: PendingUpdate): void => {
  pendingUpdate = update;
};

export const peekPendingUpdate = (): PendingUpdate | undefined => pendingUpdate;

export const takePendingUpdate = (): PendingUpdate | undefined => {
  const update = pendingUpdate;
  pendingUpdate = undefined;
  return update;
};

export const clearPendingUpdate = (): void => {
  pendingUpdate = undefined;
};
