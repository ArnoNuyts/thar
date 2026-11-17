//! Strict calendar-day values for `todo.txt` date tags.
//!
//! The TypeScript oracle parses date tags with `date-fns` `parseISO` and then
//! rejects anything outside years 1..=9999. Dates are only ever calendar days
//! here: there is no clock, timezone, or time-of-day in this type. That keeps
//! the WASM core small and removes a whole class of timezone drift.
//!
//! `parse` accepts exactly `YYYY-MM-DD`: four ASCII digits, two ASCII digits,
//! two ASCII digits, and a real calendar day (leap years included). Anything
//! else is rejected so the caller can keep the raw token in the todo text.
//!
//! [Calendar arithmetic](add_days) is date-fns-compatible: days and weeks move
//! whole days, months **clamp to the end of the target month** (`2024-01-31` +
//! 1 month is `2024-02-29`), and years are twelve months. Every operation takes
//! and returns a calendar day, so no time of day can shift the result across a
//! DST boundary, and a result outside years 1..=9999 is a deliberate `None`.
//! The TypeScript oracle performs the same arithmetic on local `Date` values
//! (`addDays`, `addWeeks`, `addMonths`, `startOfMonth`, `endOfMonth`,
//! `startOfWeek`); the recurrence planner reuses these functions instead of
//! keeping a second copy.

use core::fmt;
use core::str::FromStr;

/// A validated `todo.txt` calendar day.
///
/// Construction always validates, so a `TodoDate` is always a real day in
/// years 1..=9999. Ordering is chronological.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TodoDate {
    year: u16,
    month: u8,
    day: u8,
}

impl TodoDate {
    /// Build a date, returning `None` for an invalid calendar day or a year
    /// outside 1..=9999.
    #[must_use = "an invalid calendar day is a deliberate None"]
    pub const fn new(year: u16, month: u8, day: u8) -> Option<Self> {
        if year == 0 || year > 9999 {
            return None;
        }
        if month == 0 || month > 12 {
            return None;
        }
        if day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(Self { year, month, day })
    }

    /// Calendar year (1..=9999).
    #[must_use]
    pub const fn year(self) -> u16 {
        self.year
    }

    /// Calendar month (1..=12).
    #[must_use]
    pub const fn month(self) -> u8 {
        self.month
    }

    /// Day of month (1..=31).
    #[must_use]
    pub const fn day(self) -> u8 {
        self.day
    }
}

/// Why a string is not a valid `todo.txt` date.
///
/// Returned by [`TodoDate`]'s [`FromStr`] implementation. The message is
/// bounded and names the accepted shape; the caller usually keeps the raw
/// token in the todo text instead of showing the error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct InvalidTodoDate;

impl fmt::Display for InvalidTodoDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid todo date; expected a real YYYY-MM-DD day")
    }
}

impl std::error::Error for InvalidTodoDate {}

impl FromStr for TodoDate {
    type Err = InvalidTodoDate;

    /// Parse exactly `YYYY-MM-DD`, mirroring `parseDateTag` in `logic/dates.ts`.
    ///
    /// Leading or trailing whitespace is not accepted, and neither is an
    /// unpadded month or day (`2023-1-1`), an impossible day (`2023-02-29`), or
    /// a year outside 1..=9999.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let bytes = value.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return Err(InvalidTodoDate);
        }
        let year = parse_digits(&bytes[0..4]).ok_or(InvalidTodoDate)?;
        let month = parse_digits(&bytes[5..7]).ok_or(InvalidTodoDate)?;
        let day = parse_digits(&bytes[8..10]).ok_or(InvalidTodoDate)?;
        let month = u8::try_from(month).map_err(|_| InvalidTodoDate)?;
        let day = u8::try_from(day).map_err(|_| InvalidTodoDate)?;
        Self::new(year, month, day).ok_or(InvalidTodoDate)
    }
}

impl fmt::Display for TodoDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

/// Parse exactly `count` ASCII digits into a `u16`.
fn parse_digits(digits: &[u8]) -> Option<u16> {
    let mut value: u16 = 0;
    for &digit in digits {
        if !digit.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u16::from(digit - b'0');
    }
    Some(value)
}

/// True for years with 366 days in the proleptic Gregorian calendar.
const fn is_leap_year(year: u16) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

/// Number of days in a month; `0` for an invalid month.
#[must_use]
pub const fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Add whole calendar days.
///
/// `days` may be negative to move backwards. Returns `None` when the result
/// leaves years 1..=9999, matching `isValidTodoDate` in `logic/dates.ts`.
#[must_use = "an out-of-range result is a deliberate None"]
pub fn add_days(base: TodoDate, days: i64) -> Option<TodoDate> {
    let shifted = days_from_civil(
        i64::from(base.year()),
        i64::from(base.month()),
        i64::from(base.day()),
    )
    .checked_add(days)?;

    // Range-check before the inverse conversion: `civil_from_days` adds a
    // constant and divides, so an out-of-range day number would otherwise
    // overflow inside it.
    if !(MIN_DAY_NUMBER..=MAX_DAY_NUMBER).contains(&shifted) {
        return None;
    }

    let (year, month, day) = civil_from_days(shifted);
    to_todo_date(year, month, day)
}

/// Add whole weeks (seven calendar days each).
///
/// # Errors
///
/// Returns `None` when the week count overflows, or when the result leaves
/// years 1..=9999.
#[must_use = "an out-of-range result is a deliberate None"]
pub fn add_weeks(base: TodoDate, weeks: i64) -> Option<TodoDate> {
    add_days(base, weeks.checked_mul(7)?)
}

/// Add calendar months, clamping the day to the end of the target month.
///
/// This is `date-fns`'s `addMonths`: `2024-01-31` + 1 month is `2024-02-29`,
/// never `2024-03-02`.
///
/// # Errors
///
/// Returns `None` when the result leaves years 1..=9999.
#[must_use = "an out-of-range result is a deliberate None"]
pub fn add_months(base: TodoDate, months: i64) -> Option<TodoDate> {
    let base_months = (i64::from(base.year()) - 1) * 12 + (i64::from(base.month()) - 1);
    let total = base_months.checked_add(months)?;
    let year = total.div_euclid(12).checked_add(1)?;
    let month = total.rem_euclid(12) + 1;

    let year = u16::try_from(year).ok()?;
    let month = u8::try_from(month).ok()?;
    let day = base.day().min(days_in_month(year, month));

    TodoDate::new(year, month, day)
}

/// Add calendar years (twelve months each).
///
/// A leap day clamps: `2024-02-29` + 1 year is `2025-02-28`.
///
/// # Errors
///
/// Returns `None` when the year count overflows, or when the result leaves
/// years 1..=9999.
#[must_use = "an out-of-range result is a deliberate None"]
pub fn add_years(base: TodoDate, years: i64) -> Option<TodoDate> {
    add_months(base, years.checked_mul(12)?)
}

/// The first day of the same month.
#[must_use]
pub const fn start_of_month(date: TodoDate) -> TodoDate {
    TodoDate {
        year: date.year,
        month: date.month,
        day: 1,
    }
}

/// The last day of the same month.
#[must_use]
pub const fn end_of_month(date: TodoDate) -> TodoDate {
    TodoDate {
        year: date.year,
        month: date.month,
        day: days_in_month(date.year, date.month),
    }
}

/// Day of the week, Monday `0` through Sunday `6` (`date-fns`'s
/// `getDay` shifted so the calendar's Monday-first grid is an index).
///
/// The proleptic Gregorian calendar is used for every accepted year; 1970-01-01
/// was a Thursday and 0001-01-01 was a Monday.
#[must_use]
pub fn weekday(date: TodoDate) -> u8 {
    let days = days_from_civil(
        i64::from(date.year()),
        i64::from(date.month()),
        i64::from(date.day()),
    );
    // 1970-01-01 (day 0) was a Thursday, index 3 with Monday as zero.
    u8::try_from((days + 3).rem_euclid(7)).unwrap_or(0)
}

/// The Monday that starts the week containing `date`.
///
/// `startOfWeek(date, { weekStartsOn: 1 })` in the TypeScript calendar. The
/// result always exists: 0001-01-01 is a Monday, so no accepted date can walk
/// back before the first supported day.
#[must_use]
pub fn start_of_week_monday(date: TodoDate) -> TodoDate {
    add_days(date, -i64::from(weekday(date))).unwrap_or(date)
}

/// Build a [`TodoDate`], rejecting out-of-range years.
fn to_todo_date(year: i64, month: i64, day: i64) -> Option<TodoDate> {
    let year = u16::try_from(year).ok()?;
    let month = u8::try_from(month).ok()?;
    let day = u8::try_from(day).ok()?;
    TodoDate::new(year, month, day)
}

/// Day number of the earliest supported day, `0001-01-01`.
const MIN_DAY_NUMBER: i64 = days_from_civil(1, 1, 1);

/// Day number of the latest supported day, `9999-12-31`.
const MAX_DAY_NUMBER: i64 = days_from_civil(9999, 12, 31);

/// Days since 1970-01-01 for a proleptic Gregorian date.
///
/// Howard Hinnant's `days_from_civil`; exact for every year this crate accepts.
const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9).rem_euclid(12);
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Inverse of [`days_from_civil`].
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    let year = if month <= 2 { year + 1 } else { year };

    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::{
        TodoDate, add_days, add_months, add_weeks, add_years, days_in_month, end_of_month,
        start_of_month, start_of_week_monday, weekday,
    };

    fn date(value: &str) -> TodoDate {
        value.parse::<TodoDate>().expect("valid test date")
    }

    #[test]
    fn parses_padded_dates() {
        let date = "2024-02-29".parse::<TodoDate>().expect("leap day");
        assert_eq!((date.year(), date.month(), date.day()), (2024, 2, 29));
        assert_eq!(date.to_string(), "2024-02-29");
    }

    #[test]
    fn rejects_malformed_shapes() {
        for value in [
            "",
            "2024-02-2",
            "2024-2-29",
            "24-02-29",
            "12024-02-29",
            "2024/02/29",
            "2024-02-29 ",
            " 2024-02-29",
            "2024-02-29T00:00:00",
            "abcd-ef-gh",
        ] {
            assert!(value.parse::<TodoDate>().is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn from_str_reports_a_bounded_error() {
        let error = "2024-02-30"
            .parse::<TodoDate>()
            .expect_err("impossible day");
        assert_eq!(error, super::InvalidTodoDate);
        assert_eq!(
            error.to_string(),
            "invalid todo date; expected a real YYYY-MM-DD day"
        );
        assert!("".parse::<TodoDate>().is_err());
    }

    #[test]
    fn rejects_invalid_calendar_days_and_years() {
        for value in [
            "0000-01-01",
            "10000-1-1",
            "2023-02-29",
            "2023-13-01",
            "2023-00-10",
            "2023-04-31",
            "2023-06-00",
            "2023-11-32",
        ] {
            assert!(value.parse::<TodoDate>().is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn leap_year_rules_match_gregorian() {
        assert!(TodoDate::new(2000, 2, 29).is_some());
        assert!(TodoDate::new(2024, 2, 29).is_some());
        assert!(TodoDate::new(1900, 2, 29).is_none());
        assert!(TodoDate::new(2100, 2, 29).is_none());
    }

    #[test]
    fn year_bounds_are_inclusive() {
        let earliest = "0001-01-01".parse::<TodoDate>().expect("year 1 is valid");
        assert_eq!(
            (earliest.year(), earliest.month(), earliest.day()),
            (1, 1, 1)
        );
        let latest = "9999-12-31"
            .parse::<TodoDate>()
            .expect("year 9999 is valid");
        assert_eq!(
            (latest.year(), latest.month(), latest.day()),
            (9999, 12, 31)
        );
    }

    #[test]
    fn formats_single_digit_parts() {
        let date = TodoDate::new(7, 3, 4).expect("valid");
        assert_eq!(date.to_string(), "0007-03-04");
    }

    #[test]
    fn orders_chronologically() {
        let earlier = "2024-02-28".parse::<TodoDate>().expect("valid");
        let later = "2024-03-01".parse::<TodoDate>().expect("valid");
        assert!(earlier < later);
    }

    #[test]
    fn day_and_week_arithmetic_matches_the_calendar() {
        let cases = [
            ("2024-02-28", 1, "2024-02-29"),
            ("2024-02-29", 1, "2024-03-01"),
            ("2023-02-28", 1, "2023-03-01"),
            ("2024-12-31", 1, "2025-01-01"),
            ("2026-11-15", -1, "2026-11-14"),
            ("2024-03-01", -1, "2024-02-29"),
            ("0001-01-01", 1, "0001-01-02"),
            ("9999-12-30", 1, "9999-12-31"),
            ("2024-01-01", 366, "2025-01-01"),
            ("2023-01-01", 365, "2024-01-01"),
        ];
        for (base, days, expected) in cases {
            assert_eq!(
                add_days(date(base), days).map(|value| value.to_string()),
                Some(expected.to_owned()),
                "{base} + {days}d"
            );
        }
    }

    #[test]
    fn week_arithmetic_is_seven_days() {
        assert_eq!(
            add_weeks(date("2026-11-15"), 1).map(|d| d.to_string()),
            Some("2026-11-22".to_owned())
        );
        assert_eq!(
            add_weeks(date("2026-11-15"), -1).map(|d| d.to_string()),
            Some("2026-11-08".to_owned())
        );
        assert_eq!(
            add_weeks(date("2024-02-22"), 1).map(|d| d.to_string()),
            Some("2024-02-29".to_owned())
        );
        assert_eq!(
            add_weeks(date("2024-02-29"), 1).map(|d| d.to_string()),
            Some("2024-03-07".to_owned())
        );
    }

    #[test]
    fn month_arithmetic_clamps_to_the_target_month_end() {
        let cases = [
            ("2024-01-31", 1, "2024-02-29"),
            ("2023-01-31", 1, "2023-02-28"),
            ("2024-03-31", 1, "2024-04-30"),
            ("2024-05-31", 1, "2024-06-30"),
            ("2024-12-31", 1, "2025-01-31"),
            ("2024-01-31", -1, "2023-12-31"),
            ("2024-03-31", -1, "2024-02-29"),
            ("2024-01-15", 12, "2025-01-15"),
            ("2024-01-15", -12, "2023-01-15"),
            ("2024-02-29", 12, "2025-02-28"),
        ];
        for (base, months, expected) in cases {
            assert_eq!(
                add_months(date(base), months).map(|value| value.to_string()),
                Some(expected.to_owned()),
                "{base} + {months}m"
            );
        }
    }

    #[test]
    fn year_arithmetic_clamps_a_leap_day() {
        assert_eq!(
            add_years(date("2024-02-29"), 1).map(|d| d.to_string()),
            Some("2025-02-28".to_owned())
        );
        assert_eq!(
            add_years(date("2024-02-29"), 4).map(|d| d.to_string()),
            Some("2028-02-29".to_owned())
        );
        assert_eq!(
            add_years(date("2026-11-15"), -1).map(|d| d.to_string()),
            Some("2025-11-15".to_owned())
        );
        assert_eq!(
            add_years(date("2024-01-31"), 1).map(|d| d.to_string()),
            Some("2025-01-31".to_owned())
        );
    }

    #[test]
    fn arithmetic_rejects_results_outside_the_supported_years() {
        assert_eq!(add_days(date("9999-12-31"), 1), None);
        assert_eq!(add_days(date("0001-01-01"), -1), None);
        assert_eq!(add_weeks(date("9999-12-31"), 1), None);
        assert_eq!(add_weeks(date("0001-01-01"), -1), None);
        assert_eq!(add_months(date("9999-12-01"), 1), None);
        assert_eq!(add_months(date("0001-01-01"), -1), None);
        assert_eq!(add_years(date("9999-01-01"), 1), None);
        assert_eq!(add_years(date("0001-01-01"), -1), None);
        assert_eq!(add_days(date("2024-01-01"), i64::MAX), None);
        assert_eq!(add_weeks(date("2024-01-01"), i64::MAX), None);
        assert_eq!(add_months(date("2024-01-01"), i64::MAX), None);
        assert_eq!(add_years(date("2024-01-01"), i64::MAX), None);
    }

    #[test]
    fn extreme_day_offsets_return_none_instead_of_overflowing() {
        // `civil_from_days` adds a constant to the day number, so the range
        // check must happen before the inverse conversion.
        for base in ["0001-01-01", "1970-01-01", "9999-12-31"] {
            for days in [i64::MAX, i64::MIN, i64::MAX - 1, i64::MIN + 1] {
                assert_eq!(add_days(date(base), days), None, "{base} + {days}d");
            }
        }
    }

    #[test]
    fn month_bounds_and_lengths() {
        assert_eq!(start_of_month(date("2024-02-29")), date("2024-02-01"));
        assert_eq!(end_of_month(date("2024-02-10")), date("2024-02-29"));
        assert_eq!(end_of_month(date("2023-02-10")), date("2023-02-28"));
        assert_eq!(end_of_month(date("2026-11-15")), date("2026-11-30"));
        assert_eq!(end_of_month(date("2026-12-01")), date("2026-12-31"));
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(1900, 2), 28);
        assert_eq!(days_in_month(2000, 2), 29);
        assert_eq!(days_in_month(2026, 4), 30);
        assert_eq!(days_in_month(2026, 13), 0);
    }

    #[test]
    fn weekday_is_monday_zero() {
        // 2024-01-01 was a Monday; 2026-11-15 is a Sunday.
        assert_eq!(weekday(date("2024-01-01")), 0);
        assert_eq!(weekday(date("2024-01-07")), 6);
        assert_eq!(weekday(date("2026-11-15")), 6);
        assert_eq!(weekday(date("2026-11-16")), 0);
        assert_eq!(weekday(date("0001-01-01")), 0);
        assert_eq!(weekday(date("1970-01-01")), 3);
    }

    #[test]
    fn the_week_starts_on_monday() {
        assert_eq!(start_of_week_monday(date("2026-11-15")), date("2026-11-09"));
        assert_eq!(start_of_week_monday(date("2026-11-09")), date("2026-11-09"));
        assert_eq!(start_of_week_monday(date("0001-01-01")), date("0001-01-01"));
        assert_eq!(start_of_week_monday(date("0001-01-02")), date("0001-01-01"));
    }
}
