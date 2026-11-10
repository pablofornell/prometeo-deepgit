mod auth;
mod commands;
mod logsession;
mod state;
mod watcher;
mod workspace;

use std::sync::Arc;

use gitcore::{Git, RepoChanged};
use tauri::{Emitter, Manager};

use crate::state::AppState;
use crate::watcher::WatcherHandle;

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // try_init: a second call (tests, embedding) must not panic.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

pub fn run() {
    init_tracing();
    tauri::Builder::default()
        // must be the first plugin: a second launch has to reach the first instance before it creates windows
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;

            // Credential prompts for fetch, pull and push (see auth.rs). Without the local IPC the
            // commands still run, they just cannot ask.
            let auth = auth::init(app.handle(), config_dir.clone());
            let mut git = Git::new(None);
            if let Some(broker) = &auth.broker {
                git = git.with_auth(broker.clone());
            }
            app.manage(auth);

            let console = app.handle().clone();
            let git = git.with_sink(Arc::new(move |entry| {
                let _ = console.emit("git-console", entry);
            }));

            let changed = app.handle().clone();
            let watcher = WatcherHandle::new(Arc::new(move |repo_id: &str| {
                let _ = changed.emit(
                    "repo-changed",
                    RepoChanged {
                        repo_id: repo_id.to_string(),
                    },
                );
            }));

            let state = Arc::new(AppState::new(
                git,
                config_dir.join("workspace.json"),
                watcher,
            ));
            // Starting the watch walks every repo tree; keep it off the setup path.
            let background = state.clone();
            tauri::async_runtime::spawn_blocking(move || background.sync_watcher());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_load,
            commands::workspace_save_ui,
            commands::project_add,
            commands::project_remove,
            commands::project_rescan,
            commands::project_set_active,
            commands::project_set_color,
            commands::repo_set_color,
            commands::repo_summaries,
            commands::log_open,
            commands::log_rows,
            commands::log_find,
            commands::log_close,
            commands::refs,
            commands::commit_details,
            commands::branches_containing,
            commands::working_tree,
            commands::file_diff,
            commands::file_content,
            commands::last_commit_message,
            commands::stage,
            commands::unstage,
            commands::discard,
            commands::stage_hunk,
            commands::discard_hunk,
            commands::commit,
            commands::checkout,
            commands::branch_create,
            commands::branch_delete,
            commands::branch_rename,
            commands::merge,
            commands::rebase,
            commands::cherry_pick,
            commands::revert,
            commands::reset,
            commands::op_continue,
            commands::op_abort,
            commands::op_skip,
            commands::fetch,
            commands::pull,
            commands::push,
            commands::stash_save,
            commands::stash_apply,
            commands::stash_pop,
            commands::stash_drop,
            commands::tag_create,
            commands::tag_delete,
            commands::clone_repo,
            commands::clone_cancel,
            auth::auth_reply,
            auth::set_auth_prefs,
            auth::credentials_clear,
        ])
        .build(tauri::generate_context!())
        .expect("error while building DeepGit")
        .run(|app, event| {
            // Managed state is not dropped at exit: remove the askpass socket by hand.
            if let tauri::RunEvent::Exit = event {
                if let Some(broker) = app.state::<auth::AuthState>().broker.as_ref() {
                    broker.shutdown();
                }
            }
        });
}
