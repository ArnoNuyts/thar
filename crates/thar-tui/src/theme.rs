//! Colours and display constants, mirroring `theme/colors.ts`.
//!
//! The Ink app uses hex colours. The native backend supports 24-bit colour, so
//! the same values are used as [`Color::Rgb`]. `Color::Rgb` is also what
//! `TestBackend` records, which keeps the snapshot tests independent of the
//! running terminal's colour capability.

use ratatui::style::Color;

/// Build a colour from the same `#RRGGBB` literals `theme/colors.ts` uses.
const fn rgb(value: u32) -> Color {
    Color::Rgb(
        ((value >> 16) & 0xFF) as u8,
        ((value >> 8) & 0xFF) as u8,
        (value & 0xFF) as u8,
    )
}

/// The list background.
pub const BACKGROUND: Color = rgb(0x181818);
/// Foreground for ordinary text.
pub const FOREGROUND: Color = rgb(0xEEECE5);
/// Muted text: numbering, scrollbar, hints.
pub const MUTED: Color = rgb(0x676560);
/// Inverse foreground on primary-coloured surfaces.
pub const INVERSE_FOREGROUND: Color = rgb(0x141210);
/// Primary accent: action-bar keys, context headers, context tags.
pub const PRIMARY: Color = rgb(0xF4BF75);
/// Secondary accent: search prompt, toasts, selection background.
pub const SECONDARY: Color = rgb(0xAF76B7);
/// Errors, overdue dates, read-only indicator, `due:` suffix.
pub const DANGER: Color = rgb(0xCE7768);
/// Warning accent (search-empty query).
pub const WARNING: Color = rgb(0xDDB14D);
/// Success accent (`t:` suffix).
pub const SUCCESS: Color = rgb(0x7BA152);
/// Informational accent (`rec:` suffix).
pub const INFO: Color = rgb(0x6399C6);

/// Background of the focused todo row.
pub const FOCUS_BACKGROUND: Color = rgb(0xECECEC);
/// Background of the focused row when it is overdue.
pub const FOCUS_BACKGROUND_OVERDUE: Color = rgb(0xCE7768);
/// Background of rows inside a shift-selection range.
pub const SELECTION_BACKGROUND: Color = rgb(0xAF76B7);
/// Foreground used on every highlighted row.
pub const TEXT_ON_HIGHLIGHT: Color = rgb(0x181818);
/// `@context` tag colour.
pub const TAG_CONTEXT: Color = PRIMARY;
/// `+project` tag colour.
pub const TAG_PROJECT: Color = INFO;

/// Background of a modal surface (`COLORS.modalBackground`).
pub const MODAL_BACKGROUND: Color = rgb(0x262626);
/// Background of a selected row in a menu or calendar.
pub const SELECTED_BACKGROUND: Color = rgb(0x3A3A3A);
/// Background of a primary button.
pub const BUTTON_BACKGROUND: Color = SUCCESS;
/// Background of a dangerous confirmation button.
pub const DANGER_BACKGROUND: Color = DANGER;
/// Border colour of a focused input.
pub const INPUT_FOCUS: Color = SECONDARY;

/// Colour of the `(A)`..`(F)` priority badge.
#[must_use]
pub const fn priority_color(letter: char) -> Option<Color> {
    match letter {
        'A' => Some(rgb(0x6399C6)),
        'B' => Some(rgb(0xAF76B7)),
        'C' => Some(rgb(0xDDB14D)),
        'D' => Some(rgb(0x6399C6)),
        'E' => Some(rgb(0x7BA152)),
        'F' => Some(rgb(0xCE7768)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::Color;

    #[test]
    fn colours_match_the_typescript_palette() {
        assert_eq!(super::BACKGROUND, Color::Rgb(0x18, 0x18, 0x18));
        assert_eq!(super::PRIMARY, Color::Rgb(0xF4, 0xBF, 0x75));
        assert_eq!(super::DANGER, Color::Rgb(0xCE, 0x77, 0x68));
        assert_eq!(super::FOCUS_BACKGROUND, Color::Rgb(0xEC, 0xEC, 0xEC));
        assert_eq!(
            super::priority_color('B'),
            Some(Color::Rgb(0xAF, 0x76, 0xB7))
        );
        assert_eq!(super::priority_color('G'), None);
    }
}
