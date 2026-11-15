//! Undo/redo history.
//!
//! The TypeScript provider snapshots the whole todo array on every successful
//! mutation and keeps the snapshots on an unbounded stack. This is the same
//! model: a mutation records the state *before* it runs, undo swaps the current
//! state with the last snapshot, and redo is the mirror image. Loading a file
//! (initial load or reload) clears both stacks.
//!
//! Snapshots are `Vec<Todo>` clones. `Todo` is an immutable value type, so a
//! snapshot never aliases a live todo's strings or tag map.

use thar_core::Todo;

/// The undo and redo stacks.
#[derive(Debug, Default)]
pub struct History {
    undo: Vec<Vec<Todo>>,
    redo: Vec<Vec<Todo>>,
}

impl History {
    /// Record the state before a mutation and invalidate redo.
    pub fn record(&mut self, todos: &[Todo]) {
        self.undo.push(todos.to_vec());
        self.redo.clear();
    }

    /// True when there is a state to go back to.
    #[must_use]
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    /// True when there is a state to go forward to.
    #[must_use]
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Number of undo steps, for tests and diagnostics.
    #[must_use]
    pub fn undo_len(&self) -> usize {
        self.undo.len()
    }

    /// Number of redo steps, for tests and diagnostics.
    #[must_use]
    pub fn redo_len(&self) -> usize {
        self.redo.len()
    }

    /// Move to the previous state, pushing `current` onto redo.
    pub fn undo(&mut self, current: &[Todo]) -> Option<Vec<Todo>> {
        let previous = self.undo.pop()?;
        self.redo.push(current.to_vec());
        Some(previous)
    }

    /// Move to the next state, pushing `current` onto undo.
    pub fn redo(&mut self, current: &[Todo]) -> Option<Vec<Todo>> {
        let next = self.redo.pop()?;
        self.undo.push(current.to_vec());
        Some(next)
    }

    /// Drop both stacks, as a file load does.
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::History;
    use thar_core::{Todo, TodoId};

    fn todo(line: &str) -> Todo {
        Todo::parse_line(line, TodoId::new(0))
    }

    #[test]
    fn records_and_round_trips() {
        let mut history = History::default();
        let original = vec![todo("one")];
        history.record(&original);
        assert!(history.can_undo());
        assert!(!history.can_redo());

        let changed = vec![todo("two")];
        let restored = history.undo(&changed).expect("undo");
        assert_eq!(restored, original);
        assert!(history.can_redo());

        let forward = history.redo(&restored).expect("redo");
        assert_eq!(forward, changed);
        assert!(history.can_undo());
    }

    #[test]
    fn a_new_record_clears_redo() {
        let mut history = History::default();
        let first = vec![todo("one")];
        history.record(&first);
        let second = vec![todo("two")];
        history.record(&second);
        let _ = history.undo(&second).expect("undo");
        assert!(history.can_redo());

        history.record(&first);
        assert!(!history.can_redo());
        assert_eq!(history.undo_len(), 2);
    }

    #[test]
    fn empty_stacks_are_no_ops() {
        let mut history = History::default();
        assert_eq!(history.undo(&[]), None);
        assert_eq!(history.redo(&[]), None);
        history.clear();
        assert!(!history.can_undo() && !history.can_redo());
    }
}
