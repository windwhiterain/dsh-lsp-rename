//! A small crate the rename probe renames a symbol in.
//!
//! `widget_count` is declared here and used in `lib.rs` and in `nested/deep.rs`, so one rename
//! spans three files and exercises the multi-file write plus its rollback.

/// How many widgets the shop has built.
pub fn widget_count() -> u32 {
    7
}

/// The shop's inventory report.
pub fn report() -> String {
    let count = widget_count();
    let _ = &count;
    format!("widgets: {}", count)
}

pub mod crlf;
pub mod nested;
