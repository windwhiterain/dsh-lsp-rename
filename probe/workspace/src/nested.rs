//! The nested module, declared through `nested.rs` so `nested/deep.rs` is part of the crate graph
//! and one rename reaches it. A file outside the module tree would be indexed by nothing.

pub mod deep;
