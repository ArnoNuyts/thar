//! One owned entry per todo: the shared handle plus its cached search view.
//!
//! The app used to keep two parallel vectors, `Vec<Rc<Todo>>` and
//! `Vec<OwnedView>`, and relied on every mutation updating both in step. One
//! entry per todo makes that alignment structural: the handle and the view for
//! a todo are replaced together by [`TodoEntry::replace`], and a row build sees
//! the same slice as both the todo source and the search-view source.
//!
//! The handle keeps the undo/redo sharing intact: a snapshot copies only the
//! `Rc` handles, and a mutation replaces just the touched entry with a fresh
//! handle.

use std::borrow::Borrow;
use std::rc::Rc;

use thar_core::{SearchView, SearchViewLike, Todo};

use crate::search::{OwnedView, view_for};

/// A todo plus the lowercased search view cached for it.
#[derive(Debug)]
pub(crate) struct TodoEntry {
    todo: Rc<Todo>,
    view: OwnedView,
}

impl TodoEntry {
    /// Wrap an owned todo, building its search view once.
    pub(crate) fn new(todo: Todo) -> Self {
        let view = view_for(&todo);
        Self {
            todo: Rc::new(todo),
            view,
        }
    }

    /// Wrap an existing shared handle, rebuilding its search view.
    ///
    /// This is the undo/redo path: the restored snapshots already hold the
    /// original allocations, so only the cached views have to be derived again.
    pub(crate) fn from_shared(todo: Rc<Todo>) -> Self {
        let view = view_for(&todo);
        Self { todo, view }
    }

    /// The todo behind this entry.
    pub(crate) fn todo(&self) -> &Todo {
        &self.todo
    }

    /// The shared handle, for the undo snapshot.
    pub(crate) fn shared(&self) -> &Rc<Todo> {
        &self.todo
    }

    /// Replace the todo with a new handle and its freshly built view.
    ///
    /// Both halves are written here, so an entry can never pair a todo with the
    /// view of a different one. Untouched entries keep their handle, which is
    /// what lets an undo snapshot share them.
    pub(crate) fn replace(&mut self, todo: Todo) {
        self.view = view_for(&todo);
        self.todo = Rc::new(todo);
    }
}

impl Borrow<Todo> for TodoEntry {
    fn borrow(&self) -> &Todo {
        &self.todo
    }
}

impl SearchViewLike for TodoEntry {
    fn as_view(&self) -> SearchView<'_> {
        self.view.as_view()
    }
}
