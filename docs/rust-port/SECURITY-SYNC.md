# Security sync ledger

Security releases continue on `main`/`release/next` while this port is open.
`feature/rust-port` is downstream: merge each security release into the port
immediately, then record it here.

The port is not ready to cut over until every row is either applied to both
implementations or explicitly marked N/A with a reason.

| Date | Security release / commit | Affected code | TS applied | Rust applied | Verified |
| ---- | ------------------------- | ------------- | ---------- | ------------ | -------- |
|      |                           |               |            |              |          |

## Rules

- Fix and release on the shipping line first; never delay a security release
  for the port.
- Forward-merge the tagged release (or the specific fix commit) into
  `feature/rust-port` as soon as it exists.
- If the port has already replaced the affected code, port the fix into Rust
  and add a corpus case that would have failed before the fix.
- Re-run the port gates after every security sync, even if the merge looked
  trivial.
- Do not merge the port branch into `release/next` to "pick up" a fix; the
  direction is always release line -> port branch.
