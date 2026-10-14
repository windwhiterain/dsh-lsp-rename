//! A file with CRLF line endings and an astral-plane character before the renamed symbol, so the
//! offset math is checked against UTF-16 code units and against line endings this plugin must not
//! re-serialize.

use crate::widget_count;

/// 🌙 a comment whose emoji is two UTF-16 code units, ahead of the renamed span.
pub fn moon_phase() -> &'static str {
    if widget_count() > 0 { "waxing" } else { "new" }
}
