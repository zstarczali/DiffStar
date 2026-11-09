mod ai;
mod claude_cli;
mod commands;
mod diff;
mod dirs;
mod dups;
mod files;
mod settings;
mod thumb;
mod update;

use commands::AppState;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Paths on our own command line: `DiffStar left right` (also what
    // `git difftool` starts once DiffStar is set up as the diff tool).
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    commands::push_launch(commands::args_to_paths(&args, &cwd));

    let builder = tauri::Builder::default()
        // A second launch (e.g. another `git difftool` call) opens its files
        // as a new tab in the running DiffStar instead of a second window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = commands::args_to_paths(argv.get(1..).unwrap_or(&[]), &cwd);
            commands::push_launch(paths);
            let _ = app.emit("launch-args", ());
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    // macOS: only the application menu and Edit (needed for Cmd+C/V/X/A/Z).
    #[cfg(target_os = "macos")]
    let builder = builder.enable_macos_default_menu(false).menu(|app| {
        use tauri::menu::{Menu, PredefinedMenuItem as P, Submenu};
        let app_menu = Submenu::with_items(app, "DiffStar", true, &[
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &P::quit(app, None)?,
        ])?;
        let edit = Submenu::with_items(app, "Edit", true, &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ])?;
        Menu::with_items(app, &[&app_menu, &edit])
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(commands::window_state_flags())
                .with_denylist(&["splashscreen"])
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("DiffStar"));
            app.manage(AppState { settings: settings::SettingsStore::load(dir) });
            let started = std::time::Instant::now();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                if let Err(e) = commands::create_main_window(&handle) {
                    eprintln!("DiffStar: could not create the main window: {e}");
                }
                std::thread::sleep(commands::SPLASH_TIME.saturating_sub(started.elapsed()));
                commands::finish_splash(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "splashscreen" && matches!(event, tauri::WindowEvent::Destroyed) {
                commands::finish_splash(window.app_handle());
            }
            if window.label() == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { .. } => commands::save_window_state(window.app_handle()),
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        commands::save_window_state_later(window.app_handle())
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::set_ui_language,
            commands::take_launch_args,
            commands::path_stat,
            commands::load_file,
            commands::save_file,
            commands::write_text_file,
            commands::read_bytes,
            commands::binary_summary,
            commands::local_thumb,
            commands::find_duplicates,
            commands::cancel_dups,
            commands::dups_progress,
            commands::move_to_trash,
            commands::diff_text,
            commands::unified_patch,
            commands::compare_dirs,
            commands::cancel_compare,
            commands::compare_progress,
            commands::copy_entry,
            commands::reveal_in_explorer,
            commands::open_file,
            commands::open_url,
            commands::exe_path,
            commands::setup_git_difftool,
            commands::ai_explain,
            commands::ai_folder,
            commands::ai_test,
            commands::app_info,
            commands::set_zoom,
            commands::clipboard_text,
            update::check_for_update,
            update::download_and_install_update,
            update::update_server_check,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DiffStar");
}
