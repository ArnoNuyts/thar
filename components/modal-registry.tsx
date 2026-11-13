import type { ComponentType } from "react";
import { AddTagContextModal } from "./AddTagContextModal.tsx";
import { CreateTodoModal } from "./CreateTodoModal.tsx";
import { EditTodoModal } from "./EditTodoModal.tsx";
import { SetDateModal } from "./SetDateModal.tsx";
import { SetPriorityModal } from "./SetPriorityModal.tsx";
import { SetRecurrenceModal } from "./SetRecurrenceModal.tsx";
import { MultiSelectMenu, TodoMenu } from "./TodoMenu.tsx";
import { UpdateModal } from "./UpdateModal.tsx";
import type { GenericModalId } from "../contexts/modal-context.tsx";

/**
 * Maps every generic modal id to the component that renders it.
 *
 * The `Record<GenericModalId, ...>` type makes the map exhaustive: adding a
 * new id to `GenericModalId` without adding an entry here fails
 * `npm run typecheck`.
 */
export const modalRegistry: Record<GenericModalId, ComponentType> = {
  "create-todo": CreateTodoModal,
  "edit-todo": EditTodoModal,
  "todo-menu": TodoMenu,
  "multi-select-menu": MultiSelectMenu,
  "set-due-date": () => <SetDateModal type="due" />,
  "set-threshold-date": () => <SetDateModal type="threshold" />,
  "set-recurrence": SetRecurrenceModal,
  "set-priority": SetPriorityModal,
  "add-project": () => <AddTagContextModal type="project" />,
  "add-context": () => <AddTagContextModal type="context" />,
  "update-modal": UpdateModal,
};
