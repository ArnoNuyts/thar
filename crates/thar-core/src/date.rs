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

use core::fmt;

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

    /// Parse exactly `YYYY-MM-DD`, mirroring `parseDateTag` in `logic/dates.ts`.
    ///
    /// Leading or trailing whitespace is not accepted, and neither is an
    /// unpadded month or day (`2023-1-1`).
    #[must_use = "a malformed date is a deliberate None"]
    pub fn parse(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let year = parse_digits(&bytes[0..4])?;
        let month = parse_digits(&bytes[5..7])?;
        let day = parse_digits(&bytes[8..10])?;
        let month = u8::try_from(month).ok()?;
        let day = u8::try_from(day).ok()?;
        Self::new(year, month, day)
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
const fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::TodoDate;

    #[test]
    fn parses_padded_dates() {
        let date = TodoDate::parse("2024-02-29").expect("leap day");
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
            assert!(TodoDate::parse(value).is_none(), "accepted {value:?}");
        }
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
            assert!(TodoDate::parse(value).is_none(), "accepted {value:?}");
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
        let earliest = TodoDate::parse("0001-01-01").expect("year 1 is valid");
        assert_eq!(
            (earliest.year(), earliest.month(), earliest.day()),
            (1, 1, 1)
        );
        let latest = TodoDate::parse("9999-12-31").expect("year 9999 is valid");
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
        let earlier = TodoDate::parse("2024-02-28").expect("valid");
        let later = TodoDate::parse("2024-03-01").expect("valid");
        assert!(earlier < later);
    }
}
