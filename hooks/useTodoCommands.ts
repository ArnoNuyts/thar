import { useModal } from "../contexts/modal-context.tsx";
import { useNavigation } from "../contexts/navigation-context.tsx";
import { useToaster } from "../contexts/toaster-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { copyToClipboard, readFromClipboard } from "../logic/clipboard.ts";
import { UpperCaseLetter } from "../types/types.ts";

export interface CommandOptions {
  /** Called once the command has finished, if it acted on a selection. */
  onComplete?: () => void;
}

export interface ToggleHiddenViewOptions extends CommandOptions {
  /** Show the same confirmation toast the list view shows. */
  notify?: boolean;
}

/**
 * The commands shared by the todo list and the todo menu.
 *
 * Both views keep their own key bindings and rendering. Anything that is
 * view-specific (closing the menu, showing the hidden-view toast, or the
 * inline priority letters versus the priority modal) is passed in or exposed
 * as a separate command instead of being duplicated here.
 */
export const useTodoCommands = () => {
  const { openModal } = useModal();
  const { showToaster } = useToaster();
  const {
    addTodos,
    archiveCompletedTodos,
    deleteTodos,
    redo,
    toggleHidden,
    toggleTodos,
    undo,
    updateTodos,
  } = useTodo();
  const {
    setSelectedTodoId,
    showHidden,
    toggleShowHidden,
    useSelectedTodo,
    useSelectedTodos,
  } = useNavigation();

  const todo = useSelectedTodo();
  const selectedTodos = useSelectedTodos();

  const editSelected = () => {
    if (todo) openModal("edit-todo", todo);
  };

  const deleteSelected = () => {
    if (selectedTodos.length === 0) return;

    const isMultiple = selectedTodos.length > 1;
    openModal("confirm-modal", {
      title: isMultiple ? "Delete Todos" : "Delete Todo",
      message: isMultiple
        ? `Are you sure you want to delete ${selectedTodos.length} todos?`
        : "Are you sure you want to delete this todo?",
      onConfirm: () => deleteTodos(selectedTodos),
    });
  };

  const toggle = (todos: typeof selectedTodos) => {
    if (todos.length === 0) return;
    toggleTodos(todos);
  };

  const toggleSelected = (options: CommandOptions = {}) => {
    if (selectedTodos.length === 0) return;
    toggle(selectedTodos);
    options.onComplete?.();
  };

  const setDueDate = () => openModal("set-due-date");
  const setThresholdDate = () => openModal("set-threshold-date");
  const setRecurrence = () => openModal("set-recurrence");

  /** Inline A-F priority shortcut: pressing the current priority unsets it. */
  const setPriority = (priority: UpperCaseLetter) => {
    if (selectedTodos.length === 0) return;

    const allHaveSamePriority = selectedTodos.every((selected) =>
      selected.priority === priority
    );
    updateTodos(
      selectedTodos,
      (selected) =>
        selected.setPriority(
          allHaveSamePriority ? undefined : priority,
        ),
    );
  };

  const openPriorityModal = () => openModal("set-priority");

  const addProject = () => openModal("add-project");
  const addContext = () => openModal("add-context");

  const toggleSelectedHidden = (options: CommandOptions = {}) => {
    if (selectedTodos.length === 0) return;
    toggleHidden(selectedTodos);
    options.onComplete?.();
  };

  const toggleHiddenView = (options: ToggleHiddenViewOptions = {}) => {
    toggleShowHidden();
    if (options.notify) {
      showToaster(showHidden ? "Hidden todos hidden" : "Hidden todos shown");
    }
    options.onComplete?.();
  };

  /** Archive the completed todos and wait for the write to finish. */
  const archiveCompleted = async () => {
    await archiveCompletedTodos();
  };

  const archiveSelected = () => {
    openModal("confirm-modal", {
      title: "Archive Completed",
      message: "Archive all completed todos to done.txt?",
      onConfirm: archiveCompleted,
    });
  };

  const copySelected = async (options: CommandOptions = {}) => {
    if (selectedTodos.length === 0) return;

    try {
      await copyToClipboard(
        selectedTodos.map((selected) => selected.toString()).join("\n"),
      );
      showToaster(
        selectedTodos.length === 1
          ? "Todo copied"
          : `${selectedTodos.length} todos copied`,
      );
    } catch (e) {
      showToaster(
        `Copy failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    options.onComplete?.();
  };

  const undoCommand = (options: CommandOptions = {}) => {
    undo();
    options.onComplete?.();
  };

  const redoCommand = (options: CommandOptions = {}) => {
    redo();
    options.onComplete?.();
  };

  const pasteTodos = async (options: CommandOptions = {}) => {
    const finish = () => options.onComplete?.();

    try {
      const text = await readFromClipboard();
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (lines.length === 0) {
        finish();
        return;
      }

      const doPaste = () => {
        const added = addTodos(...lines);
        if (added.length > 0) {
          setSelectedTodoId(added[added.length - 1].id);
        }
        showToaster(`Pasted ${lines.length} todo(s)`);
        finish();
      };

      if (lines.length > 10) {
        openModal("confirm-modal", {
          title: "Paste Multiple Todos",
          message: `Are you sure you want to paste ${lines.length} todos?`,
          onConfirm: doPaste,
        });
      } else {
        doPaste();
      }
    } catch (e) {
      showToaster(
        `Paste failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      finish();
    }
  };

  return {
    selectedTodo: todo,
    selectedTodos,
    editSelected,
    deleteSelected,
    toggle,
    toggleSelected,
    setDueDate,
    setThresholdDate,
    setRecurrence,
    setPriority,
    openPriorityModal,
    addProject,
    addContext,
    toggleSelectedHidden,
    toggleHiddenView,
    archiveCompleted,
    archiveSelected,
    copySelected,
    undo: undoCommand,
    redo: redoCommand,
    pasteTodos,
  };
};
