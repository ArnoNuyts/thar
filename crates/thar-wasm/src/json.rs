//! A minimal JSON reader plus the writer helpers shared by the envelopes.
//!
//! The crate deliberately carries no serializer dependency: every document it
//! returns is written by hand so the field order is visible in the code and the
//! module stays inside the WASM size budget. The one document that arrives from
//! JavaScript (`build_rows`'s request) needs a reader, so this module implements
//! the subset of RFC 8259 that `JSON.stringify` can produce — and nothing more:
//!
//! - objects, arrays, strings, numbers, `true`, `false`, and `null`;
//! - `\uXXXX` escapes, including surrogate pairs (a lone surrogate, which
//!   `JSON.stringify` can emit for a broken string, becomes `U+FFFD` because a
//!   Rust `String` cannot hold it);
//! - no comments, no trailing commas, no `NaN`/`Infinity`;
//! - a nesting cap ([`MAX_DEPTH`]) so a hostile input cannot exhaust the stack.
//!
//! Object keys keep insertion order in a `Vec`, which is all the request
//! decoding needs; duplicate keys resolve to the first value. Errors carry a
//! byte offset and a fixed reason, never a slice of the input, so a rejected
//! todo line cannot leak into a log through a JSON error.

/// Deepest array/object nesting the reader accepts.
///
/// The `build_rows` request nests an object, an array, and a two-element array
/// at most; 32 leaves room for future fields while keeping the recursive
/// descent bounded.
pub(crate) const MAX_DEPTH: usize = 32;

/// One decoded JSON value.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Value {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number. The value is not kept: the request has no numeric fields, so
    /// only the syntax is validated (which also keeps the float parser out of
    /// the WASM binary).
    Number,
    /// A string, with escapes resolved.
    String(String),
    /// An array, in document order.
    Array(Vec<Value>),
    /// An object, in document order.
    Object(Vec<(String, Value)>),
}

impl Value {
    /// The value of `key` when this is an object; the first duplicate wins.
    pub(crate) fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(fields) => fields
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    /// The string, when this is one.
    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    /// The boolean, when this is one.
    pub(crate) fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    /// The array, when this is one.
    pub(crate) fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(values) => Some(values),
            _ => None,
        }
    }
}

/// Why the byte stream could not be read as JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ParseError {
    /// Byte offset where the problem was detected.
    pub(crate) offset: usize,
    /// Fixed description, never derived from the input.
    pub(crate) reason: &'static str,
}

/// Parse one complete JSON document.
pub(crate) fn parse(text: &str) -> Result<Value, ParseError> {
    let mut reader = Reader {
        bytes: text.as_bytes(),
        position: 0,
    };
    let value = reader.value(0)?;
    reader.skip_whitespace();
    if reader.position != reader.bytes.len() {
        return Err(reader.error("trailing characters after the document"));
    }
    Ok(value)
}

/// A byte-at-a-time reader over already-decoded UTF-8.
struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Reader<'_> {
    /// A parse error at the current position.
    fn error(&self, reason: &'static str) -> ParseError {
        ParseError {
            offset: self.position,
            reason,
        }
    }

    /// The current byte, or an unterminated-document error.
    fn peek(&self) -> Result<u8, ParseError> {
        self.bytes
            .get(self.position)
            .copied()
            .ok_or_else(|| self.error("unexpected end of the document"))
    }

    /// Consume `expected`, or fail.
    fn expect(&mut self, expected: u8, reason: &'static str) -> Result<(), ParseError> {
        if self.peek()? == expected {
            self.position += 1;
            Ok(())
        } else {
            Err(self.error(reason))
        }
    }

    /// Skip JSON whitespace (space, tab, CR, LF only).
    fn skip_whitespace(&mut self) {
        while let Some(byte) = self.bytes.get(self.position) {
            match byte {
                b' ' | b'\t' | b'\n' | b'\r' => self.position += 1,
                _ => break,
            }
        }
    }

    /// One value, recursing no deeper than [`MAX_DEPTH`].
    fn value(&mut self, depth: usize) -> Result<Value, ParseError> {
        if depth > MAX_DEPTH {
            return Err(self.error("nested too deeply"));
        }
        self.skip_whitespace();

        match self.peek()? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => self.string().map(Value::String),
            b't' => self.literal("true", Value::Bool(true)),
            b'f' => self.literal("false", Value::Bool(false)),
            b'n' => self.literal("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(self.error("unexpected character")),
        }
    }

    /// A literal token (`true`, `false`, `null`).
    fn literal(&mut self, token: &str, value: Value) -> Result<Value, ParseError> {
        if self.bytes[self.position..].starts_with(token.as_bytes()) {
            self.position += token.len();
            Ok(value)
        } else {
            Err(self.error("unknown literal"))
        }
    }

    /// An array, `[` value (`,` value)* `]`.
    fn array(&mut self, depth: usize) -> Result<Value, ParseError> {
        self.expect(b'[', "expected an array")?;
        let mut values = Vec::new();
        self.skip_whitespace();
        if self.peek()? == b']' {
            self.position += 1;
            return Ok(Value::Array(values));
        }

        loop {
            values.push(self.value(depth + 1)?);
            self.skip_whitespace();
            match self.peek()? {
                b',' => self.position += 1,
                b']' => {
                    self.position += 1;
                    return Ok(Value::Array(values));
                }
                _ => return Err(self.error("expected `,` or `]`")),
            }
        }
    }

    /// An object, `{` string `:` value (`,` …)* `}`.
    fn object(&mut self, depth: usize) -> Result<Value, ParseError> {
        self.expect(b'{', "expected an object")?;
        let mut fields = Vec::new();
        self.skip_whitespace();
        if self.peek()? == b'}' {
            self.position += 1;
            return Ok(Value::Object(fields));
        }

        loop {
            self.skip_whitespace();
            let key = self.string()?;
            self.skip_whitespace();
            self.expect(b':', "expected `:`")?;
            let value = self.value(depth + 1)?;
            fields.push((key, value));
            self.skip_whitespace();
            match self.peek()? {
                b',' => self.position += 1,
                b'}' => {
                    self.position += 1;
                    return Ok(Value::Object(fields));
                }
                _ => return Err(self.error("expected `,` or `}`")),
            }
        }
    }

    /// A number. Only the syntax matters: nothing reads the value.
    fn number(&mut self) -> Result<Value, ParseError> {
        if self.peek()? == b'-' {
            self.position += 1;
        }
        // Integer part: `0` alone, or a nonzero digit followed by digits.
        match self.peek()? {
            b'0' => self.position += 1,
            b'1'..=b'9' => {
                self.position += 1;
                while matches!(self.bytes.get(self.position), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return Err(self.error("expected a digit")),
        }
        // Fraction.
        if self.bytes.get(self.position) == Some(&b'.') {
            self.position += 1;
            if !matches!(self.bytes.get(self.position), Some(b'0'..=b'9')) {
                return Err(self.error("expected a digit after `.`"));
            }
            while matches!(self.bytes.get(self.position), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        // Exponent.
        if matches!(self.bytes.get(self.position), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.bytes.get(self.position), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.bytes.get(self.position), Some(b'0'..=b'9')) {
                return Err(self.error("expected a digit in the exponent"));
            }
            while matches!(self.bytes.get(self.position), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }

        Ok(Value::Number)
    }

    /// A string, resolving escapes.
    fn string(&mut self) -> Result<String, ParseError> {
        self.expect(b'"', "expected a string")?;
        let mut out = String::new();
        let mut segment_start = self.position;

        loop {
            let byte = self.peek()?;
            match byte {
                b'"' => {
                    self.push_segment(&mut out, segment_start, self.position)?;
                    self.position += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.push_segment(&mut out, segment_start, self.position)?;
                    self.position += 1;
                    self.escape(&mut out)?;
                    segment_start = self.position;
                }
                0x00..=0x1F => {
                    return Err(self.error("control character in a string"));
                }
                _ => self.position += 1,
            }
        }
    }

    /// Append `bytes[start..end]` as UTF-8.
    ///
    /// The slices always end on an ASCII delimiter, so they are valid UTF-8;
    /// the check keeps the reader total instead of relying on that argument.
    fn push_segment(&self, out: &mut String, start: usize, end: usize) -> Result<(), ParseError> {
        let segment = core::str::from_utf8(&self.bytes[start..end])
            .map_err(|_| self.error("invalid UTF-8 in a string"))?;
        out.push_str(segment);
        Ok(())
    }

    /// Read one escape sequence (the backslash is already consumed).
    fn escape(&mut self, out: &mut String) -> Result<(), ParseError> {
        let byte = self.peek()?;
        self.position += 1;
        match byte {
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'b' => out.push('\u{0008}'),
            b'f' => out.push('\u{000C}'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'u' => {
                let unit = self.hex4()?;
                match unit {
                    0xD800..=0xDBFF => {
                        // A high surrogate needs the matching low unit. A lone
                        // one cannot become a Rust `char`, so it degrades to
                        // the replacement character.
                        let low = self.low_surrogate();
                        match low.and_then(|low| combine_surrogates(unit, low)) {
                            Some(character) => out.push(character),
                            None => out.push(char::REPLACEMENT_CHARACTER),
                        }
                    }
                    0xDC00..=0xDFFF => out.push(char::REPLACEMENT_CHARACTER),
                    _ => match char::from_u32(u32::from(unit)) {
                        Some(character) => out.push(character),
                        None => out.push(char::REPLACEMENT_CHARACTER),
                    },
                }
            }
            _ => return Err(self.error("unknown escape sequence")),
        }
        Ok(())
    }

    /// Read the low half of a surrogate pair when one follows.
    ///
    /// A `\u` unit that is not a low surrogate is left in place: only the four
    /// hex digits are consumed, so the caller's next iteration sees the
    /// following escape or text.
    fn low_surrogate(&mut self) -> Option<u16> {
        if self.bytes.get(self.position) != Some(&b'\\')
            || self.bytes.get(self.position + 1) != Some(&b'u')
        {
            return None;
        }
        let start = self.position;
        self.position += 2;
        match self.hex4() {
            Ok(unit) if (0xDC00..=0xDFFF).contains(&unit) => Some(unit),
            Ok(_) => {
                // Put the escape back: the digits belong to the next value.
                self.position = start;
                None
            }
            Err(_) => {
                self.position = start;
                None
            }
        }
    }

    /// Read exactly four hex digits as one UTF-16 code unit.
    fn hex4(&mut self) -> Result<u16, ParseError> {
        let digits = self
            .bytes
            .get(self.position..self.position + 4)
            .ok_or_else(|| self.error("short `\\u` escape"))?;
        let mut unit = 0u16;
        for digit in digits {
            unit = unit
                .checked_mul(16)
                .and_then(|value| hex_value(*digit).map(|digit| value + u16::from(digit)))
                .ok_or_else(|| self.error("invalid `\\u` escape"))?;
        }
        self.position += 4;
        Ok(unit)
    }
}

/// One hex digit's value.
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Combine a validated surrogate pair into one scalar value.
fn combine_surrogates(high: u16, low: u16) -> Option<char> {
    let high = u32::from(high) - 0xD800;
    let low = u32::from(low) - 0xDC00;
    char::from_u32(0x1_0000 + (high << 10) + low)
}

// ---- Writer helpers -------------------------------------------------------
//
// Every envelope is assembled into one `String`; these helpers keep the
// escaping identical between the parse records and the row records.

/// Append formatted arguments without an unreachable `expect`.
///
/// `fmt::Write` for `String` is infallible, so a `write!` here can never return
/// `Err`. The `Result` is dropped in this one documented place rather than
/// repeated as `.expect(…)` at every call site.
pub(crate) fn push_fmt(out: &mut String, args: core::fmt::Arguments<'_>) {
    let _ = core::fmt::Write::write_fmt(out, args);
}

/// Append `true` or `false`.
pub(crate) fn push_json_bool(out: &mut String, value: bool) {
    out.push_str(if value { "true" } else { "false" });
}

/// Append a JSON number.
pub(crate) fn push_json_number(out: &mut String, value: u64) {
    push_fmt(out, format_args!("{value}"));
}

/// Append a one-character JSON string (a priority letter).
///
/// Delegates to [`push_json_string`] instead of pushing quotes by hand, so a
/// future non-`[A-Z]` priority is escaped like any other text.
pub(crate) fn push_json_char(out: &mut String, value: char) {
    let mut buffer = [0u8; 4];
    push_json_string(out, value.encode_utf8(&mut buffer));
}

/// Append a JSON string, escaping exactly what `JSON.stringify` escapes.
///
/// `U+2028`/`U+2029` are escaped as well: they are legal raw inside a JSON
/// string, but a caller may embed the document in a JavaScript source context
/// where they are line terminators. The escaping is transparent to
/// `JSON.parse`, so the contract bytes are unaffected.
pub(crate) fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            control if u32::from(control) < 0x20 => {
                push_fmt(out, format_args!("\\u{:04x}", u32::from(control)));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

/// Append `null` or a quoted `YYYY-MM-DD` date.
pub(crate) fn push_optional_date(out: &mut String, date: Option<thar_core::TodoDate>) {
    match date {
        Some(date) => {
            // Digits and `-` need no escaping, and `Display` writes straight
            // into `out`, so this does not allocate a temporary `String`.
            push_fmt(out, format_args!("\"{date}\""));
        }
        None => out.push_str("null"),
    }
}

/// Append a JSON array of strings.
pub(crate) fn push_json_string_array(out: &mut String, values: &[String]) {
    out.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_json_string(out, value);
    }
    out.push(']');
}

#[cfg(test)]
mod tests {
    use super::{MAX_DEPTH, Value, parse};

    fn string(value: &str) -> Value {
        parse(value).expect("valid JSON")
    }

    #[test]
    fn reads_the_build_rows_shape() {
        let value = string(
            r#"{"today":"2026-11-15","showHidden":false,"terms":["work"],
                "todos":[{"text":"a","tags":[["k","v"],["m",["1","2"]]]}],
                "searchViews":[{"text":"a","contexts":[],"projects":["work"]}]}"#,
        );

        assert_eq!(
            value.get("today").and_then(Value::as_str),
            Some("2026-11-15")
        );
        assert_eq!(
            value.get("showHidden").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            value
                .get("terms")
                .and_then(Value::as_array)
                .map(|terms| terms.len()),
            Some(1)
        );
        let todo = &value.get("todos").and_then(Value::as_array).expect("array")[0];
        assert_eq!(todo.get("text").and_then(Value::as_str), Some("a"));
        assert!(todo.get("missing").is_none());
    }

    #[test]
    fn resolves_escapes_and_surrogate_pairs() {
        let value =
            string(r#""quote \" backslash \\ slash \/ \b \f \n \r \t \u0041 \uD83D\uDE80""#);
        assert_eq!(
            value,
            Value::String(
                "quote \" backslash \\ slash / \u{0008} \u{000C} \n \r \t A 🚀".to_owned()
            )
        );
    }

    #[test]
    fn degrades_lone_surrogates_to_the_replacement_character() {
        assert_eq!(string(r#""\uD83D""#), Value::String("\u{FFFD}".to_owned()));
        assert_eq!(
            string(r#""\uD83Dx""#),
            Value::String("\u{FFFD}x".to_owned())
        );
        assert_eq!(string(r#""\uDE80""#), Value::String("\u{FFFD}".to_owned()));
    }

    #[test]
    fn keeps_utf8_text_and_rejects_a_bare_control() {
        assert_eq!(
            string(r#""héllo 🚀 @work""#),
            Value::String("héllo 🚀 @work".to_owned())
        );
        let error = parse("\"a\u{0001}b\"").expect_err("raw control");
        assert_eq!(error.reason, "control character in a string");
    }

    #[test]
    fn rejects_malformed_documents() {
        let cases = [
            ("", "unexpected end of the document"),
            (" ", "unexpected end of the document"),
            ("{", "unexpected end of the document"),
            ("{} {}", "trailing characters after the document"),
            ("{'a':1}", "expected a string"),
            ("{\"a\" 1}", "expected `:`"),
            ("{\"a\":1,}", "expected a string"),
            ("[1,]", "unexpected character"),
            ("[1 2]", "expected `,` or `]`"),
            ("nul", "unknown literal"),
            ("NaN", "unexpected character"),
            ("01", "trailing characters after the document"),
            ("1.", "expected a digit after `.`"),
            ("1e", "expected a digit in the exponent"),
            ("-", "unexpected end of the document"),
            ("\"\\q\"", "unknown escape sequence"),
            ("\"\\u12\"", "short `\\u` escape"),
            ("\"\\uZZZZ\"", "invalid `\\u` escape"),
            ("\"unterminated", "unexpected end of the document"),
        ];

        for (text, reason) in cases {
            let error = parse(text).expect_err(text);
            assert_eq!(error.reason, reason, "input {text:?}");
        }
    }

    #[test]
    fn rejects_excessive_nesting_instead_of_overflowing_the_stack() {
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 2), "]".repeat(MAX_DEPTH + 2));
        let error = parse(&deep).expect_err("too deep");
        assert_eq!(error.reason, "nested too deeply");

        // One level inside the cap still parses.
        let shallow = format!("{}1{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse(&shallow).is_ok());
    }

    #[test]
    fn numbers_are_parsed_for_syntax_only() {
        for text in ["0", "-0", "12", "-3.5", "1e10", "1E+10", "2.5e-3"] {
            assert!(matches!(string(text), Value::Number), "{text}");
        }
    }
}
