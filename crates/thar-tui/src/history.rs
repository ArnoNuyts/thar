//! Undo/redo history.
//!
//! The TypeScript provider snapshots the whole todo array on every successful
//! mutation and keeps the snapshots on an unbounded stack. This is the same
//! model with a bounded stack: a mutation records the state *before* it runs,
//! undo swaps the current state with the last snapshot, and redo is the mirror
//! image. Loading a file (initial load or reload) clears both stacks.
//!
//! Snapshots are `Vec<Rc<Todo>>`. Recording a snapshot copies only the handle
//! vector, so unchanged todos are shared between the snapshot and the live
//! list. A mutation replaces just the touched element with a fresh
//! `Rc<Todo>`; every other todo stays shared. The stacks are capped at
//! [`MAX_HISTORY`] snapshots: a long editing session drops the oldest step
//! instead of growing without bound.
//!
//! [`History::undo`] and [`History::redo`] take the live vector and swap it in
//! place with [`std::mem::take`], so a successful swap does not clone the list
//! and does not clone any `Todo`.

use std::collections::VecDeque;
use std::rc::Rc;

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
    undo: VecDeque<Vec<Rc<Todo>>>,
    redo: VecDeque<Vec<Rc<Todo>>>,
}

impl History {
    /// Record the state before a mutation and invalidate redo.
    ///
    /// Only the `Rc` handles are copied; the todos themselves stay shared with
    /// the live list. The oldest snapshot is dropped once the stack is at
    /// [`MAX_HISTORY`].
    pub fn record<'a>(&mut self, todos: impl IntoIterator<Item = &'a Rc<Todo>>) {
        push_capped(&mut self.undo, todos.into_iter().map(Rc::clone).collect());
        self.redo.clear();
    }

    /// Number of undo steps, for tests and diagnostics.
    #[must_use]
    pub fn undo_len(&self) -> usize {
        self.undo.len()
    }

    /// Number of redo steps, for tests.
    #[cfg(test)]
    #[must_use]
    pub fn redo_len(&self) -> usize {
        self.redo.len()
    }

    /// Move to the previous state, pushing the replaced state onto redo.
    ///
    /// The swap moves the handle vectors, so no `Todo` is cloned. Returns false
    /// when there is nothing to undo; `current` is untouched in that case.
    pub fn undo(&mut self, current: &mut Vec<Rc<Todo>>) -> bool {
        let Some(previous) = self.undo.pop_back() else {
            return false;
        };
        let replaced = std::mem::take(current);
        *current = previous;
        push_capped(&mut self.redo, replaced);
        true
    }

    /// Move to the next state, pushing the replaced state onto undo.
    ///
    /// The swap moves the handle vectors, so no `Todo` is cloned. Returns false
    /// when there is nothing to redo; `current` is untouched in that case.
    pub fn redo(&mut self, current: &mut Vec<Rc<Todo>>) -> bool {
        let Some(next) = self.redo.pop_back() else {
            return false;
        };
        let replaced = std::mem::take(current);
        *current = next;
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
fn push_capped(stack: &mut VecDeque<Vec<Rc<Todo>>>, snapshot: Vec<Rc<Todo>>) {
    if stack.len() >= MAX_HISTORY {
        stack.pop_front();
    }
    stack.push_back(snapshot);
}

#[cfg(test)]
mod tests {
    use super::{History, MAX_HISTORY};
    use std::rc::Rc;
    use thar_core::{Todo, TodoId};

    fn todo(line: &str) -> Todo {
        Todo::parse_line(line, TodoId::new(0))
    }

    fn shared(line: &str) -> Rc<Todo> {
        Rc::new(todo(line))
    }

    #[test]
    fn records_and_round_trips() {
        let mut history = History::default();
        let original = vec![shared("one")];
        history.record(&original);
        assert_eq!(history.undo_len(), 1);
        assert_eq!(history.redo.len(), 0);

        let mut current = vec![shared("two")];
        assert!(history.undo(&mut current));
        assert_eq!(current, original);
        assert_eq!(history.redo.len(), 1);

        assert!(history.redo(&mut current));
        assert_eq!(current, vec![shared("two")]);
        assert_eq!(history.undo_len(), 1);
    }

    #[test]
    fn a_new_record_clears_redo() {
        let mut history = History::default();
        let first = vec![shared("one")];
        history.record(&first);
        let second = vec![shared("two")];
        history.record(&second);
        let mut current = second.clone();
        assert!(history.undo(&mut current));
        assert_eq!(history.redo.len(), 1);

        history.record(&first);
        assert_eq!(history.redo.len(), 0);
        assert_eq!(history.undo_len(), 2);
    }

    #[test]
    fn the_stack_is_capped_and_drops_the_oldest_step() {
        let mut history = History::default();
        for index in 0..MAX_HISTORY + 5 {
            history.record(&[shared(&format!("todo {index}"))]);
        }
        assert_eq!(history.undo_len(), MAX_HISTORY);

        // Walking all the way back must stop at the oldest kept snapshot, not
        // the first one ever recorded.
        let mut current = vec![shared("now")];
        for _ in 0..MAX_HISTORY {
            assert!(history.undo(&mut current));
        }
        assert_eq!(history.undo_len(), 0);
        assert_eq!(current, vec![shared("todo 5")]);
        assert_eq!(history.redo.len(), MAX_HISTORY);
    }

    #[test]
    fn empty_stacks_are_no_ops_and_leave_the_list_alone() {
        let mut history = History::default();
        let mut current = vec![shared("one")];
        assert!(!history.undo(&mut current));
        assert!(!history.redo(&mut current));
        assert_eq!(current, vec![shared("one")]);
        history.clear();
        assert_eq!(history.undo_len(), 0);
        assert_eq!(history.redo.len(), 0);
    }

    #[test]
    fn a_snapshot_shares_unchanged_todos_with_the_live_list() {
        let mut history = History::default();
        let original = vec![shared("one"), shared("two")];
        let first = Rc::clone(&original[0]);
        let second = Rc::clone(&original[1]);

        history.record(&original);
        // The local handle, the live vector and the snapshot. A deep clone
        // would leave only the first two, which is what this asserts against.
        assert_eq!(Rc::strong_count(&first), 3);
        assert_eq!(Rc::strong_count(&second), 3);

        let mut current = vec![Rc::clone(&first), Rc::clone(&second)];
        // An unrelated edit replaces only the touched element. The untouched
        // todo stays shared with the snapshot instead of being deep-cloned.
        current[1] = Rc::new(todo("two edited"));
        assert!(Rc::ptr_eq(&current[0], &original[0]));
        assert_eq!(
            Rc::strong_count(&second),
            3,
            "the untouched todo is still only in the local handle, live list and snapshot"
        );

        // Undo swaps the handle vectors; the restored todo is the same
        // allocation the snapshot recorded, not a copy.
        assert!(history.undo(&mut current));
        assert!(Rc::ptr_eq(&current[0], &original[0]));
        assert!(Rc::ptr_eq(&current[1], &original[1]));
        assert_eq!(Rc::strong_count(&second), 3);
    }
}
