//! A second file that also uses the renamed symbol, so one rename spans more than one file.

use crate::widget_count;

/// A line that uses the count twice, on one line.
pub fn total() -> u32 {
    widget_count() + widget_count()
}
