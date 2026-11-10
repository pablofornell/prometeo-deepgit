// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // git and ssh run this executable as their askpass helper (GIT_ASKPASS / SSH_ASKPASS): answer
    // and exit before any window, GTK or Tauri code starts.
    if let Some(code) = askpass::run_from_env() {
        std::process::exit(code);
    }
    deepgit_lib::run()
}
