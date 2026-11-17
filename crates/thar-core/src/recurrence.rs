//! Recurrence planning for `rec:` tags.
//!
//! Behaviour follows `logic/recurrence.ts` exactly:
//!
//! - the value grammar is `^\+?(\d+)([dwmy])$` with ASCII digits and a
//!   lowercase unit only;
//! - an amount of `0`, a value above [`MAX_RECURRENCE_AMOUNT`], or a number
//!   that is not a JavaScript safe integer is out of range; every other shape
//!   is invalid;
//! - the two rejection messages are the exact user-facing strings the toggle
//!   flow shows;
//! - the base day is an argument, never the clock, and the arithmetic is
//!   date-fns-compatible calendar arithmetic: days and weeks move whole days,
//!   months **clamp** to the end of the target month (`2024-01-31` + 1 month is
//!   `2024-02-29`), and years are twelve months.
//!
//! The TS oracle works on local `Date` values with a time of day. This crate
//! only ever carries calendar days, so the time of day cannot shift the result
//! across a DST boundary; `addDays`/`addWeeks` on a day is the same day plus
//! `n` days.
//!
//! # Example
//!
//! ```
//! use thar_core::{TodoDate, plan_recurrence};
//!
//! let base = "2024-01-31".parse::<TodoDate>().expect("valid");
//! let next = plan_recurrence("1m", base).expect("valid recurrence");
//! assert_eq!(next.to_string(), "2024-02-29");
//! ```

use core::fmt;
use core::str::FromStr;

use crate::date::{TodoDate, add_days, add_months, add_weeks, add_years};

/// Upper bound for `rec:` amounts so serialized values stay sane.
pub const MAX_RECURRENCE_AMOUNT: u32 = 9_999;

const INVALID_MESSAGE: &str = "Invalid recurrence value; no new todo was created";
const OUT_OF_RANGE_MESSAGE: &str = "Recurrence is out of range; no new todo was created";

/// The unit of a `rec:` value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RecurrenceUnit {
    /// `d`: whole calendar days.
    Days,
    /// `w`: whole weeks (seven calendar days).
    Weeks,
    /// `m`: calendar months, clamped to the end of the target month.
    Months,
    /// `y`: calendar years (twelve months).
    Years,
}

/// A parsed and validated `rec:` value.
///
/// Construction always validates, so a `Recurrence` is always storable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Recurrence {
    amount: u32,
    unit: RecurrenceUnit,
}

impl FromStr for Recurrence {
    type Err = RecurrenceError;

    /// Parse a `rec:` value, mirroring `parseRecurrence` in
    /// `logic/recurrence.ts`.
    ///
    /// # Errors
    ///
    /// Returns [`RecurrenceError::Invalid`] when the value does not match
    /// `^\+?(\d+)([dwmy])$`, and [`RecurrenceError::OutOfRange`] when the
    /// amount is zero or above [`MAX_RECURRENCE_AMOUNT`].
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let rest = value.strip_prefix('+').unwrap_or(value);
        let mut characters = rest.chars();
        let unit = match characters.next_back() {
            Some('d') => RecurrenceUnit::Days,
            Some('w') => RecurrenceUnit::Weeks,
            Some('m') => RecurrenceUnit::Months,
            Some('y') => RecurrenceUnit::Years,
            _ => return Err(RecurrenceError::Invalid),
        };

        let digits = characters.as_str();
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(RecurrenceError::Invalid);
        }

        // JavaScript parses with `Number` and then requires a safe integer;
        // saturating arithmetic keeps absurd digit strings out of range
        // instead of overflowing.
        let mut amount: u32 = 0;
        for digit in digits.bytes() {
            amount = amount
                .saturating_mul(10)
                .saturating_add(u32::from(digit - b'0'));
        }

        if amount == 0 || amount > MAX_RECURRENCE_AMOUNT {
            return Err(RecurrenceError::OutOfRange);
        }

        Ok(Self { amount, unit })
    }
}

impl Recurrence {
    /// The amount, always `1..=`[`MAX_RECURRENCE_AMOUNT`].
    #[must_use]
    pub const fn amount(self) -> u32 {
        self.amount
    }

    /// The unit.
    #[must_use]
    pub const fn unit(self) -> RecurrenceUnit {
        self.unit
    }

    /// Resolve the next due day relative to `base`.
    ///
    /// # Errors
    ///
    /// Returns [`RecurrenceError::OutOfRange`] when the result leaves the
    /// supported years 1..=9999, matching `isValidTodoDate(nextDue)` in the
    /// oracle.
    #[must_use = "the planned day must be used"]
    pub fn plan(self, base: TodoDate) -> Result<TodoDate, RecurrenceError> {
        let planned = match self.unit {
            RecurrenceUnit::Days => add_days(base, i64::from(self.amount)),
            RecurrenceUnit::Weeks => add_weeks(base, i64::from(self.amount)),
            RecurrenceUnit::Months => add_months(base, i64::from(self.amount)),
            RecurrenceUnit::Years => add_years(base, i64::from(self.amount)),
        };

        planned.ok_or(RecurrenceError::OutOfRange)
    }
}

/// Why a `rec:` value or plan was rejected.
///
/// The variants carry the exact TypeScript messages, because the toggle flow
/// shows them in the TUI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecurrenceError {
    /// The value does not match `^\+?(\d+)([dwmy])$`.
    Invalid,
    /// The amount, or the planned result, is out of range.
    OutOfRange,
}

impl RecurrenceError {
    /// The user-facing message, identical to `logic/recurrence.ts`.
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Invalid => INVALID_MESSAGE,
            Self::OutOfRange => OUT_OF_RANGE_MESSAGE,
        }
    }
}

impl fmt::Display for RecurrenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for RecurrenceError {}

/// True when `value` can be stored in a `rec:` tag.
///
/// # Example
///
/// ```
/// use thar_core::is_valid_recurrence;
///
/// assert!(is_valid_recurrence("+2d"));
/// assert!(!is_valid_recurrence("0d"));
/// assert!(!is_valid_recurrence("10000d"));
/// assert!(!is_valid_recurrence("1D"));
/// ```
#[must_use]
pub fn is_valid_recurrence(value: &str) -> bool {
    value.parse::<Recurrence>().is_ok()
}

/// Resolve the next due day for a `rec:` value relative to `base`.
///
/// This is the direct port of `planRecurrence`; it never panics on user data.
///
/// # Errors
///
/// Returns the [`RecurrenceError`] for an invalid or out-of-range value, or for
/// a plan that would leave years 1..=9999.
#[must_use = "the planned day must be used"]
pub fn plan_recurrence(value: &str, base: TodoDate) -> Result<TodoDate, RecurrenceError> {
    value.parse::<Recurrence>()?.plan(base)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_RECURRENCE_AMOUNT, Recurrence, RecurrenceError, RecurrenceUnit, is_valid_recurrence,
        plan_recurrence,
    };
    use crate::date::TodoDate;

    fn date(value: &str) -> TodoDate {
        value.parse::<TodoDate>().expect("valid test date")
    }

    fn next(value: &str, base: &str) -> String {
        plan_recurrence(value, date(base))
            .expect("valid recurrence plan")
            .to_string()
    }

    #[test]
    fn parses_every_unit_with_an_optional_plus() {
        for (value, unit, amount) in [
            ("1d", RecurrenceUnit::Days, 1),
            ("2w", RecurrenceUnit::Weeks, 2),
            ("3m", RecurrenceUnit::Months, 3),
            ("1y", RecurrenceUnit::Years, 1),
            ("+1d", RecurrenceUnit::Days, 1),
            ("+9999y", RecurrenceUnit::Years, MAX_RECURRENCE_AMOUNT),
            ("0001d", RecurrenceUnit::Days, 1),
        ] {
            let recurrence = value.parse::<Recurrence>().expect("valid recurrence");
            assert_eq!(recurrence.amount(), amount, "amount for {value:?}");
            assert_eq!(recurrence.unit(), unit, "unit for {value:?}");
        }
    }

    #[test]
    fn rejects_malformed_values_as_invalid() {
        for value in [
            "", "d", "1", "x1d", "1dd", "1d2", "1 d", "01dd", "1D", "1W", "abc", "-1d", "++1d",
            "+d", "1d ", " 1d", "1M",
        ] {
            assert_eq!(
                value.parse::<Recurrence>(),
                Err(RecurrenceError::Invalid),
                "value {value:?}"
            );
            assert!(!is_valid_recurrence(value), "value {value:?}");
        }
    }

    #[test]
    fn rejects_zero_and_out_of_range_amounts() {
        for value in [
            "0d",
            "00w",
            "0000m",
            "10000d",
            "999999999999y",
            "999999999999999999999d",
        ] {
            assert_eq!(
                value.parse::<Recurrence>(),
                Err(RecurrenceError::OutOfRange),
                "value {value:?}"
            );
        }

        assert!("9999d".parse::<Recurrence>().is_ok());
        assert!("9999y".parse::<Recurrence>().is_ok());
    }

    #[test]
    fn messages_match_the_oracle() {
        assert_eq!(
            RecurrenceError::Invalid.message(),
            "Invalid recurrence value; no new todo was created"
        );
        assert_eq!(
            RecurrenceError::OutOfRange.message(),
            "Recurrence is out of range; no new todo was created"
        );
        assert_eq!(
            RecurrenceError::OutOfRange.to_string(),
            "Recurrence is out of range; no new todo was created"
        );
    }

    #[test]
    fn plans_daily_weekly_monthly_and_yearly_intervals() {
        assert_eq!(next("1d", "2026-01-15"), "2026-01-16");
        assert_eq!(next("2w", "2026-01-15"), "2026-01-29");
        assert_eq!(next("1m", "2026-01-15"), "2026-02-15");
        assert_eq!(next("1y", "2026-01-15"), "2027-01-15");
        assert_eq!(next("+2d", "2026-01-15"), "2026-01-17");
        assert_eq!(next("9999d", "2026-01-15"), "2053-06-01");
    }

    #[test]
    fn clamps_month_ends_and_leap_days() {
        assert_eq!(next("1m", "2024-01-31"), "2024-02-29");
        assert_eq!(next("1m", "2026-01-31"), "2026-02-28");
        assert_eq!(next("1y", "2024-02-29"), "2025-02-28");
        assert_eq!(next("12m", "2024-02-29"), "2025-02-28");
        assert_eq!(next("9m", "2024-05-31"), "2025-02-28");
        assert_eq!(next("4y", "2024-02-29"), "2028-02-29");
        assert_eq!(next("1m", "2024-03-31"), "2024-04-30");
        assert_eq!(next("1m", "2024-12-31"), "2025-01-31");
    }

    #[test]
    fn crosses_year_boundaries() {
        assert_eq!(next("1d", "2026-12-31"), "2027-01-01");
        assert_eq!(next("1w", "2026-12-29"), "2027-01-05");
        assert_eq!(next("1m", "2026-12-15"), "2027-01-15");
        assert_eq!(next("1y", "2026-12-31"), "2027-12-31");
        assert_eq!(next("1d", "0001-01-01"), "0001-01-02");
    }

    #[test]
    fn reports_overflow_as_out_of_range() {
        for (value, base) in [
            ("1y", "9999-01-01"),
            ("1m", "9999-12-01"),
            ("1w", "9999-12-31"),
            ("1d", "9999-12-31"),
            ("9999d", "9999-12-31"),
            ("9999y", "9999-12-31"),
        ] {
            assert_eq!(
                plan_recurrence(value, date(base)),
                Err(RecurrenceError::OutOfRange),
                "value {value:?} base {base:?}"
            );
        }
    }

    #[test]
    fn day_arithmetic_matches_the_calendar_across_the_supported_range() {
        for (base, following) in [
            ("0001-01-01", "0001-01-02"),
            ("1582-10-04", "1582-10-05"),
            ("1900-02-28", "1900-03-01"),
            ("1970-01-01", "1970-01-02"),
            ("2000-02-28", "2000-02-29"),
            ("2024-02-28", "2024-02-29"),
            ("2024-02-29", "2024-03-01"),
            ("2026-11-15", "2026-11-16"),
            ("9999-12-30", "9999-12-31"),
        ] {
            assert_eq!(next("1d", base), following, "base {base:?}");
        }

        // Round trip: add a day, then subtract it with a 2-day plan from the
        // day before the base. This pins the civil/day-number conversion on
        // both ends instead of only comparing formatted strings.
        for base in ["0001-01-01", "1900-02-28", "2024-02-29", "9999-12-31"] {
            let start = date(base);
            if let Ok(day_after) = plan_recurrence("1d", start) {
                assert_eq!(
                    plan_recurrence("2d", start).ok(),
                    plan_recurrence("1d", day_after).ok(),
                    "base {base:?}"
                );
            }
        }
    }
}
