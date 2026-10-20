import type { ComponentType } from "react";
import { AddTagContextModal } from "./AddTagContextModal.tsx";
import { CreateTodoModal } from "./CreateTodoModal.tsx";
import { EditTodoModal } from "./EditTodoModal.tsx";
import { SetDateModal } from "./SetDateModal.tsx";
import { SetPriorityModal } from "./SetPriorityModal.tsx";
import { SetRecurrenceModal } from "./SetRecurrenceModal.tsx";
import { TodoMenu } from "./TodoMenu.tsx";
import type { ModalId } from "../contexts/modal-context.tsx";

/**
 * Modal ids rendered without extra data. `confirm-modal` is excluded because
 * it renders from `modalData` instead.
 */
export type GenericModalId = Exclude<ModalId, "confirm-modal">;

/**
 * Maps every generic modal id to the component that renders it.
 *
 * The `Record<GenericModalId, ...>` type makes the map exhaustive: adding a
 * new id to `ModalId` without adding an entry here fails `deno check`.
 */
export const modalRegistry: Record<GenericModalId, ComponentType> = {
  "create-todo": CreateTodoModal,
  "edit-todo": EditTodoModal,
  "todo-menu": TodoMenu,
  "set-due-date": () => <SetDateModal type="due" />,
  "set-threshold-date": () => <SetDateModal type="threshold" />,
  "set-recurrence": SetRecurrenceModal,
  "set-priority": SetPriorityModal,
  "add-project": () => <AddTagContextModal type="project" />,
  "add-context": () => <AddTagContextModal type="context" />,
};
