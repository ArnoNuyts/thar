//! The update-available screen.
//!
//! Ported from `components/UpdateModal.tsx`. This build has no update check and
//! no self-update: the screen renders an [`UpdateModel`] the host supplies, and
//! "Update now" only records intent with a bounded toast. The network work,
//! the skip cache and `thar update` arrive with a future release.
//!
//! Layout: four content lines (version, install method, command, release
//! notes), a blank margin row, then the button row. The width is 70% and the
//! mouse map splits the button row proportionally between the visible actions.

use ratatui::Frame;
use ratatui::crossterm::event::{KeyCode, KeyEvent};
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::Paragraph;

use crate::event::MouseInput;
use crate::modal::buttons::Row;
use crate::modal::geometry::{self, ModalRect, ModalWidth};
use crate::modal::text;
use crate::modal::{Action, Modal, ModalId, Outcome};
use crate::theme;

/// Toast shown by "Update now" while the updater is unavailable in this build.
pub const SELF_UPDATE_MESSAGE: &str = "Self-update is not available in this build";

/// How the running binary was installed, mirroring `logic/install-method.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallKind {
    /// `npm install -g`.
    NpmGlobal,
    /// `pnpm add -g`.
    PnpmGlobal,
    /// `yarn global add`.
    YarnGlobal,
    /// `bun add -g`.
    BunGlobal,
    /// Volta.
    Volta,
    /// `npx`.
    Npx,
    /// `pnpm dlx`.
    PnpmDlx,
    /// `bunx`.
    Bunx,
    /// Homebrew.
    Homebrew,
    /// Scoop.
    Scoop,
    /// A source checkout.
    Dev,
    /// A single executable.
    Sea,
    /// Not detected.
    Unknown,
}

impl InstallKind {
    /// The label the Ink modal shows.
    #[must_use]
    pub const fn describe(self) -> &'static str {
        match self {
            Self::NpmGlobal => "npm (global)",
            Self::PnpmGlobal => "pnpm (global)",
            Self::YarnGlobal => "yarn (global)",
            Self::BunGlobal => "bun (global)",
            Self::Volta => "Volta",
            Self::Npx => "npx (ephemeral)",
            Self::PnpmDlx => "pnpm dlx (ephemeral)",
            Self::Bunx => "bunx (ephemeral)",
            Self::Homebrew => "Homebrew",
            Self::Scoop => "Scoop",
            Self::Dev => "development checkout",
            Self::Sea => "single executable",
            Self::Unknown => "unknown",
        }
    }
}

/// Everything the update screen needs, supplied by the host.
///
/// `App::update_model` is `None` by default; the list's `u` key only opens the
/// screen when the host has set it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateModel {
    /// Running version.
    pub current_version: String,
    /// Latest published version, when known.
    pub latest_version: Option<String>,
    /// Detected install method.
    pub install_kind: InstallKind,
    /// Command that would update this install.
    pub command: String,
    /// Release-notes URL.
    pub release_url: String,
    /// True when this install can update itself.
    pub can_self_update: bool,
}

impl Default for UpdateModel {
    fn default() -> Self {
        Self {
            current_version: "0.0.0".to_owned(),
            latest_version: None,
            install_kind: InstallKind::Unknown,
            command: String::new(),
            release_url: String::new(),
            can_self_update: false,
        }
    }
}

impl UpdateModel {
    /// The four content lines, in the Ink order.
    #[must_use]
    pub fn content(&self) -> String {
        let latest = self.latest_version.as_deref().unwrap_or("unknown");
        [
            format!("Current: v{}  →  Latest: v{latest}", self.current_version),
            format!("Install method: {}", self.install_kind.describe()),
            format!("Command: {}", self.command),
            format!("Release notes: {}", self.release_url),
        ]
        .join("\n")
    }
}

/// One button on the update screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdateAction {
    UpdateNow,
    Later,
    Skip,
}

impl UpdateAction {
    const fn label(self) -> &'static str {
        match self {
            Self::UpdateNow => "Update now",
            Self::Later => "Later",
            Self::Skip => "Skip this version",
        }
    }
}

/// The update-available screen.
pub struct UpdateModal {
    model: UpdateModel,
    /// Shared button row, in [`UpdateModal::actions`] order.
    buttons: Row,
    terminal_width: u16,
    terminal_height: u16,
}

impl UpdateModal {
    /// An update screen sized for the terminal it will open in.
    #[must_use]
    pub fn new(model: UpdateModel, terminal_width: u16, terminal_height: u16) -> Self {
        Self {
            model,
            buttons: Row::default(),
            terminal_width,
            terminal_height,
        }
    }

    /// The model this screen renders.
    #[must_use]
    pub fn model(&self) -> &UpdateModel {
        &self.model
    }

    fn width_for(&self) -> ModalWidth {
        ModalWidth::Percent(70)
    }

    /// The visible actions, which depend on whether self-update is possible.
    fn actions(&self) -> Vec<UpdateAction> {
        if self.model.can_self_update {
            vec![
                UpdateAction::UpdateNow,
                UpdateAction::Later,
                UpdateAction::Skip,
            ]
        } else {
            vec![UpdateAction::Later, UpdateAction::Skip]
        }
    }

    fn content_lines(&self) -> Vec<String> {
        text::wrap(&self.model.content(), self.content_width())
    }

    /// Content width shared by wrapping and rendering.
    fn content_width(&self) -> u16 {
        self.width_for()
            .resolve(self.terminal_width)
            .saturating_sub(5)
    }

    fn button_row(&self) -> u16 {
        // One blank margin row above the buttons, matching the Ink modal's
        // `buttonRowIndex = lines + 1`.
        u16::try_from(self.content_lines().len())
            .unwrap_or(u16::MAX)
            .saturating_add(1)
    }

    fn geometry(&self) -> ModalRect {
        geometry::resolve(
            Rect::new(0, 0, self.terminal_width, self.terminal_height),
            self.width_for(),
            self.body_rows(),
        )
    }

    fn activate(&self, index: usize) -> Outcome {
        match self.actions().get(index) {
            Some(UpdateAction::UpdateNow) => Outcome::Actions(vec![
                Action::Close,
                Action::Toast(SELF_UPDATE_MESSAGE.to_owned()),
            ]),
            Some(UpdateAction::Skip) => {
                let version = self
                    .model
                    .latest_version
                    .as_deref()
                    .unwrap_or("this version");
                Outcome::Actions(vec![
                    Action::Close,
                    Action::Toast(format!("Skipped v{version}")),
                ])
            }
            Some(UpdateAction::Later) => Outcome::Close,
            None => Outcome::Continue,
        }
    }
}

impl Modal for UpdateModal {
    fn id(&self) -> ModalId {
        ModalId::Update
    }

    fn title(&self) -> &str {
        "Update available"
    }

    fn width(&self) -> ModalWidth {
        self.width_for()
    }

    fn body_rows(&self) -> u16 {
        u16::try_from(self.content_lines().len())
            .unwrap_or(u16::MAX)
            .saturating_add(2)
    }

    fn resize(&mut self, width: u16, height: u16) {
        self.terminal_width = width;
        self.terminal_height = height;
    }

    fn handle_key(&mut self, key: KeyEvent) -> Outcome {
        if key.code == KeyCode::Esc {
            return Outcome::Close;
        }
        self.buttons
            .on_key(key, self.actions().len())
            .map_or(Outcome::Continue, |index| self.activate(index))
    }

    fn handle_mouse(&mut self, mouse: MouseInput) -> Outcome {
        let rect = self.geometry();
        self.buttons
            .on_mouse(rect, self.button_row(), self.actions().len(), mouse)
            .map_or(Outcome::Continue, |index| self.activate(index))
    }

    fn render(&self, frame: &mut Frame, rect: ModalRect) {
        let base = Style::default()
            .fg(theme::FOREGROUND)
            .bg(theme::MODAL_BACKGROUND);
        let content_x = rect.body.x.saturating_add(1);
        let content_width = self.content_width();

        for (index, line) in self.content_lines().iter().enumerate() {
            let offset = u16::try_from(index).unwrap_or(u16::MAX);
            if offset >= rect.body.height {
                break;
            }
            let area = Rect::new(
                content_x,
                rect.body.y.saturating_add(offset),
                content_width,
                1,
            );
            let style = match index {
                1 => base.fg(theme::MUTED).add_modifier(Modifier::DIM),
                3 => base.fg(theme::INFO),
                _ => base,
            };
            frame.render_widget(Paragraph::new(Span::styled(line.clone(), style)), area);
        }

        let labels: Vec<&str> = self.actions().iter().map(|action| action.label()).collect();
        super::buttons::render(
            frame,
            rect,
            self.button_row(),
            &labels,
            self.buttons.selected,
            self.buttons.hovered,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{InstallKind, SELF_UPDATE_MESSAGE, UpdateModal, UpdateModel};
    use crate::event::{MouseInput, MouseKind};
    use crate::modal::{Action, Modal, ModalId, Outcome};
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    fn model(can_self_update: bool) -> UpdateModel {
        UpdateModel {
            current_version: "0.4.0".to_owned(),
            latest_version: Some("0.5.0".to_owned()),
            install_kind: InstallKind::NpmGlobal,
            command: "npm install -g @arnoarnoarno/thar@latest".to_owned(),
            release_url: "https://github.com/ArnoNuyts/thar/releases/tag/v0.5.0".to_owned(),
            can_self_update,
        }
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn actions(outcome: Outcome) -> Vec<Action> {
        match outcome {
            Outcome::Actions(actions) => actions,
            _ => panic!("expected actions"),
        }
    }

    #[test]
    fn the_content_lines_match_the_ink_modal() {
        let content = model(true).content();
        assert!(content.contains("Current: v0.4.0  →  Latest: v0.5.0"));
        assert!(content.contains("Install method: npm (global)"));
        assert!(content.contains("Command: npm install -g"));
        assert!(content.contains("Release notes: https://github.com/"));
        assert_eq!(InstallKind::Npx.describe(), "npx (ephemeral)");
        assert_eq!(InstallKind::Homebrew.describe(), "Homebrew");
        assert_eq!(InstallKind::Unknown.describe(), "unknown");
    }

    #[test]
    fn the_screen_is_seventy_percent_wide_and_has_four_chrome_rows() {
        let modal = UpdateModal::new(model(true), 100, 30);
        assert_eq!(modal.id(), ModalId::Update);
        assert_eq!(modal.title(), "Update available");
        assert_eq!(modal.width().resolve(100), 70);
        // The long release URL wraps at 65 content columns, so the body is five
        // content lines plus the margin and button rows.
        assert_eq!(modal.body_rows(), 7);
    }

    #[test]
    fn self_updatable_installs_offer_three_actions() {
        let mut modal = UpdateModal::new(model(true), 100, 30);
        assert_eq!(modal.actions().len(), 3);
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::Close, Action::Toast(SELF_UPDATE_MESSAGE.to_owned())]
        );

        // Later is the second action and only closes.
        let mut modal = UpdateModal::new(model(true), 100, 30);
        modal.handle_key(key(KeyCode::Tab));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Close
        ));

        // Skip is the third and reports the version.
        let mut modal = UpdateModal::new(model(true), 100, 30);
        modal.handle_key(key(KeyCode::Tab));
        modal.handle_key(key(KeyCode::Tab));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::Close, Action::Toast("Skipped v0.5.0".to_owned())]
        );
    }

    #[test]
    fn ephemeral_installs_have_no_update_now() {
        let mut modal = UpdateModal::new(model(false), 100, 30);
        assert_eq!(modal.actions().len(), 2);
        // The first action is Later.
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Close
        ));
        modal.handle_key(key(KeyCode::Tab));
        assert_eq!(
            actions(modal.handle_key(key(KeyCode::Enter))),
            vec![Action::Close, Action::Toast("Skipped v0.5.0".to_owned())]
        );
    }

    #[test]
    fn escape_closes_and_tab_wraps() {
        let mut modal = UpdateModal::new(model(true), 100, 30);
        modal.handle_key(key(KeyCode::Left));
        assert_eq!(modal.buttons.selected, 2);
        modal.handle_key(key(KeyCode::Right));
        assert_eq!(modal.buttons.selected, 0);
        assert!(matches!(
            modal.handle_key(key(KeyCode::Esc)),
            Outcome::Close
        ));
    }

    #[test]
    fn backtab_moves_the_selection_back() {
        let mut modal = UpdateModal::new(model(true), 100, 30);
        assert_eq!(modal.buttons.selected, 0);
        assert!(matches!(
            modal.handle_key(key(KeyCode::BackTab)),
            Outcome::Continue
        ));
        assert_eq!(modal.buttons.selected, 2);
        modal.handle_key(key(KeyCode::Tab));
        assert_eq!(modal.buttons.selected, 0);
    }

    #[test]
    fn a_stale_hover_does_not_override_the_keyboard_selection() {
        let mut modal = UpdateModal::new(model(true), 100, 30);
        let rect = modal.geometry();
        let button_y = rect.body.y + modal.button_row();
        // Hover Skip: the last slice of the 65 content columns.
        let hover_skip = MouseInput {
            kind: MouseKind::Move,
            x: rect.area.x + 50,
            y: button_y + 1,
            shift: false,
        };
        assert!(matches!(modal.handle_mouse(hover_skip), Outcome::Continue));
        assert_eq!(modal.buttons.hovered, Some(2));
        assert_eq!(modal.buttons.selected, 0);

        // Right selects Later, then Enter activates Later (close), not the
        // stale Skip hover.
        assert!(matches!(
            modal.handle_key(key(KeyCode::Right)),
            Outcome::Continue
        ));
        assert_eq!(modal.buttons.selected, 1);
        assert_eq!(modal.buttons.hovered, Some(2));
        assert!(matches!(
            modal.handle_key(key(KeyCode::Enter)),
            Outcome::Close
        ));
    }

    #[test]
    fn the_mouse_map_is_proportional() {
        let mut modal = UpdateModal::new(model(true), 100, 30);
        let rect = modal.geometry();
        let button_y = rect.body.y + modal.button_row();
        // 70 wide with three actions over the 65 content columns: 0..=20
        // update, 21..=41 later, 42..=64 skip.
        let hover = MouseInput {
            kind: MouseKind::Move,
            x: rect.area.x + 50,
            y: button_y + 1,
            shift: false,
        };
        assert!(matches!(modal.handle_mouse(hover), Outcome::Continue));
        assert_eq!(modal.buttons.hovered, Some(2));

        let click = MouseInput {
            kind: MouseKind::LeftClick,
            x: rect.area.x + 10,
            y: button_y + 1,
            shift: false,
        };
        assert_eq!(
            actions(modal.handle_mouse(click)),
            vec![Action::Close, Action::Toast(SELF_UPDATE_MESSAGE.to_owned())]
        );
    }
}
