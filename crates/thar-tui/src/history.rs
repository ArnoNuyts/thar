//! Undo/redo history.
//!
//! The TypeScript provider snapshots the whole todo array on every successful
//! mutation and keeps the snapshots on an unbounded stack. This is the same
//! model with a bounded stack: a mutation records the state *before* it runs,
//! undo swaps the current state with the last snapshot, and redo is the mirror
//! image. Loading a file (initial load or reload) clears both stacks.
//!
//! Snapshots are `Vec<Todo>` clones. `Todo` is an immutable value type, so a
//! snapshot never aliases a live todo's strings or tag map. The stacks are
//! capped at [`MAX_HISTORY`] snapshots: a long editing session drops the oldest
//! step instead of growing without bound.
//!
//! [`History::undo`] and [`History::redo`] take the live vector and swap it in
//! place with [`std::mem::take`], so a successful swap does not clone the whole
//! list.

use std::collections::VecDeque;

use thar_core::Todo;

/// Maximum number of snapshots kept on each stack.
///
/// The cap is policy, not a performance tuning knob: 100 steps is far more than
/// a user reaches for and keeps a 10 000-todo list from pinning gigabytes of
/// history.
pub const MAX_HISTORY: usize = 100;

/// The undo and redo stacks.
#[derive(Debug, Default)]
pub struct History {
    undo: VecDeque<Vec<Todo>>,
    redo: VecDeque<Vec<Todo>>,
}

impl History {
    /// Record the state before a mutation and invalidate redo.
    ///
    /// The oldest snapshot is dropped once the stack is at [`MAX_HISTORY`].
    pub fn record(&mut self, todos: &[Todo]) {
        push_capped(&mut self.undo, todos.to_vec());
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

    /// Move to the previous state, pushing the replaced state onto redo.
    ///
    /// Returns false when there is nothing to undo; `current` is untouched in
    /// that case.
    pub fn undo(&mut self, current: &mut Vec<Todo>) -> bool {
        let Some(previous) = self.undo.pop_back() else {
            return false;
        };
        let replaced = std::mem::replace(current, previous);
        push_capped(&mut self.redo, replaced);
        true
    }

    /// Move to the next state, pushing the replaced state onto undo.
    ///
    /// Returns false when there is nothing to redo; `current` is untouched in
    /// that case.
    pub fn redo(&mut self, current: &mut Vec<Todo>) -> bool {
        let Some(next) = self.redo.pop_back() else {
            return false;
        };
        let replaced = std::mem::replace(current, next);
        push_capped(&mut self.undo, replaced);
        true
    }

    /// Drop both stacks, as a file load does.
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }
}

/// Push a snapshot, dropping the oldest once the cap is reached.
fn push_capped(stack: &mut VecDeque<Vec<Todo>>, snapshot: Vec<Todo>) {
    if stack.len() >= MAX_HISTORY {
        stack.pop_front();
    }
    stack.push_back(snapshot);
}

#[cfg(test)]
mod tests {
    use super::{History, MAX_HISTORY};
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

        let mut current = vec![todo("two")];
        assert!(history.undo(&mut current));
        assert_eq!(current, original);
        assert!(history.can_redo());

        assert!(history.redo(&mut current));
        assert_eq!(current, vec![todo("two")]);
        assert!(history.can_undo());
    }

    #[test]
    fn a_new_record_clears_redo() {
        let mut history = History::default();
        let first = vec![todo("one")];
        history.record(&first);
        let second = vec![todo("two")];
        history.record(&second);
        let mut current = second.clone();
        assert!(history.undo(&mut current));
        assert!(history.can_redo());

        history.record(&first);
        assert!(!history.can_redo());
        assert_eq!(history.undo_len(), 2);
    }

    #[test]
    fn the_stack_is_capped_and_drops_the_oldest_step() {
        let mut history = History::default();
        for index in 0..MAX_HISTORY + 5 {
            history.record(&[todo(&format!("todo {index}"))]);
        }
        assert_eq!(history.undo_len(), MAX_HISTORY);

        // Walking all the way back must stop at the oldest kept snapshot, not
        // the first one ever recorded.
        let mut current = vec![todo("now")];
        for _ in 0..MAX_HISTORY {
            assert!(history.undo(&mut current));
        }
        assert!(!history.can_undo());
        assert_eq!(current, vec![todo("todo 5")]);
        assert_eq!(history.redo_len(), MAX_HISTORY);
    }

    #[test]
    fn empty_stacks_are_no_ops_and_leave_the_list_alone() {
        let mut history = History::default();
        let mut current = vec![todo("one")];
        assert!(!history.undo(&mut current));
        assert!(!history.redo(&mut current));
        assert_eq!(current, vec![todo("one")]);
        history.clear();
        assert!(!history.can_undo() && !history.can_redo());
    }
}
