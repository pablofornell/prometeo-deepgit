//! The helper mode of the app as a stand-alone program, for the integration tests (and for trying
//! it by hand). The app itself does the same at the start of its `main`.
//!
//! Without the `DEEPGIT_ASKPASS*` variables it exits 1.

fn main() {
    std::process::exit(askpass::run_from_env().unwrap_or(1));
}
