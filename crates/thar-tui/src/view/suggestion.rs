//! The floating project/context suggestion popup.
//!
//! The Ink app draws one absolute overlay above every other layer
//! (`SuggestionOverlay.tsx`), sized to the longest suggestion and anchored
//! under the typed `+`/`@` marker. This module is the ratatui equivalent: a
//! pure layout function plus the paint pass. It deliberately knows nothing
//! about the editor or search state; callers hand it an [`Overlay`] and the
//! frame bounds.
//!
//! The popup is drawn after the active modal, so it can cover the modal border
//! exactly like the TypeScript root-level overlay.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph};

use crate::suggest::{MAX_ROWS, Overlay, TagKind, visible_range};
use crate::theme;

/// A resolved popup rectangle and the slice of items it shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Popup {
    /// The bordered box.
    pub area: Rect,
    /// First visible item index.
    pub first: usize,
    /// Exclusive last visible item index.
    pub last: usize,
}

/// Resolve the popup rectangle for `overlay` inside `bounds`.
///
/// The width is the longest name plus one leading space, the tag prefix and a
/// trailing padding cell, plus the two border columns. The left edge is placed
/// so the row's visible prefix lands on the typed marker. Everything is
/// clamped inside the frame; when there is no room below the anchor the popup
/// flips above it, then shrinks.
#[must_use]
pub fn layout(overlay: &Overlay<'_>, bounds: Rect) -> Option<Popup> {
    let items = overlay.suggestions.items();
    if items.is_empty() {
        return None;
    }

    let name_width = items
        .iter()
        .map(|item| u16::try_from(Line::from(item.as_str()).width()).unwrap_or(u16::MAX))
        .max()
        .unwrap_or(0);
    if name_width == 0 {
        return None;
    }

    // " " + prefix + name + " " inside the borders.
    let width = name_width
        .saturating_add(5)
        .min(bounds.width.saturating_sub(1))
        .max(5);
    let rows = MAX_ROWS.min(items.len());
    let mut height = u16::try_from(rows).unwrap_or(0).saturating_add(2);

    // The visible prefix is at popup.x + 2 (border + leading space), so the
    // box starts two columns left of the marker.
    let mut x = overlay.anchor.x.saturating_sub(2);
    let max_x = bounds.x.saturating_add(bounds.width.saturating_sub(width));
    x = x.min(max_x).max(bounds.x);

    let mut y = overlay.anchor.y;
    if y.saturating_add(height) > bounds.y.saturating_add(bounds.height) {
        let above = overlay.anchor.y.saturating_sub(height).saturating_sub(1);
        if above >= bounds.y {
            y = above;
        } else {
            height = bounds
                .y
                .saturating_add(bounds.height)
                .saturating_sub(y)
                .max(3);
        }
    }

    let visible_rows = usize::from(height.saturating_sub(2)).min(MAX_ROWS);
    let (first, last) = visible_range(items.len(), overlay.suggestions.selected(), visible_rows);
    Some(Popup {
        area: Rect::new(x, y, width, height),
        first,
        last,
    })
}

/// Draw the popup, if it has anything to show.
pub fn render(frame: &mut Frame, overlay: &Overlay<'_>, bounds: Rect) {
    let Some(popup) = layout(overlay, bounds) else {
        return;
    };

    frame.render_widget(Clear, popup.area);
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(theme::PRIMARY))
            .style(Style::default().bg(theme::BACKGROUND).fg(theme::FOREGROUND)),
        popup.area,
    );

    let inner = Rect::new(
        popup.area.x.saturating_add(1),
        popup.area.y.saturating_add(1),
        popup.area.width.saturating_sub(2),
        popup.area.height.saturating_sub(2),
    );
    if inner.width == 0 || inner.height == 0 {
        return;
    }

    let items = overlay.suggestions.items();
    let kind = overlay.suggestions.kind();
    let selected = overlay.suggestions.selected();

    for (row, index) in (popup.first..popup.last).enumerate() {
        let Some(item) = items.get(index) else {
            break;
        };
        if row >= usize::from(inner.height) {
            break;
        }

        let is_selected = index == selected;
        let style = if is_selected {
            Style::default()
                .bg(theme::FOCUS_BACKGROUND)
                .fg(theme::INFO)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().bg(theme::BACKGROUND).fg(theme::FOREGROUND)
        };

        let text = format!(" {}{}", prefix(kind), item);
        let area = Rect::new(
            inner.x,
            inner
                .y
                .saturating_add(u16::try_from(row).unwrap_or(u16::MAX)),
            inner.width,
            1,
        );
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(text, style))).style(style),
            area,
        );
    }
}

/// The visible `+`/`@` marker.
fn prefix(kind: TagKind) -> char {
    match kind {
        TagKind::Project => '+',
        TagKind::Context => '@',
    }
}

#[cfg(test)]
mod tests {
    use super::{layout, prefix};
    use crate::suggest::{Anchor, Overlay, Suggestions, TagKind, TagSources};
    use ratatui::layout::Rect;

    fn suggestions() -> (Suggestions, TagSources) {
        let sources = TagSources {
            projects: vec!["thar".to_owned(), "thar-tui".to_owned()],
            contexts: vec![],
        };
        let mut suggestions = Suggestions::new();
        suggestions.update(&sources, "buy +th", 7);
        (suggestions, sources)
    }

    #[test]
    fn the_popup_is_sized_to_the_longest_name_and_anchored_at_the_marker() {
        let (suggestions, _sources) = suggestions();
        let overlay = Overlay {
            anchor: Anchor { x: 30, y: 10 },
            suggestions: &suggestions,
        };
        let popup = layout(&overlay, Rect::new(0, 0, 100, 30)).expect("popup");
        assert_eq!(popup.area.width, 8 + 5); // "thar-tui" + prefix/space/borders
        assert_eq!(popup.area.x, 28);
        assert_eq!(popup.area.y, 10);
        assert_eq!((popup.first, popup.last), (0, 2));
    }

    #[test]
    fn the_popup_clamps_and_flips_above_the_anchor() {
        let (suggestions, _sources) = suggestions();
        let overlay = Overlay {
            anchor: Anchor { x: 95, y: 28 },
            suggestions: &suggestions,
        };
        let popup = layout(&overlay, Rect::new(0, 0, 40, 30)).expect("popup");
        assert!(popup.area.x + popup.area.width <= 40);
        assert!(popup.area.y + popup.area.height <= 30);
        assert!(popup.area.y < 28, "the popup should flip above the anchor");
    }

    #[test]
    fn the_prefix_matches_the_tag_kind() {
        assert_eq!(prefix(TagKind::Project), '+');
        assert_eq!(prefix(TagKind::Context), '@');
    }
}
