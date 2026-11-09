//! Tauri commands: everything the UI can ask from the backend.

use crate::settings::{tr, Settings, SettingsStore};
use crate::{ai, diff, dirs, files};
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub settings: SettingsStore,
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ───────────────────────────── settings ─────────────────────────────

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.get()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    state.settings.save(settings)
}

/// The UI tells the backend which language to use for its messages.
#[tauri::command]
pub fn set_ui_language(lang: String) {
    crate::settings::set_english(lang == "en");
}

// ───────────────────────────── launch arguments ─────────────────────────────

/// Paths given on the command line (`DiffStar a.txt b.txt`), by this process
/// and by later launches that the single-instance plugin forwards here.
static LAUNCH: Mutex<Vec<Vec<String>>> = Mutex::new(Vec::new());

/// Turns command line arguments into absolute paths (options are skipped).
pub fn args_to_paths(args: &[String], cwd: &str) -> Vec<String> {
    args.iter()
        .filter(|a| !a.starts_with('-') && !a.trim().is_empty())
        .map(|a| {
            let p = PathBuf::from(a);
            let p = if p.is_absolute() { p } else { Path::new(cwd).join(p) };
            p.to_string_lossy().into_owned()
        })
        .collect()
}

pub fn push_launch(paths: Vec<String>) {
    if !paths.is_empty() {
        LAUNCH.lock().unwrap().push(paths);
    }
}

/// Launch requests not yet handled by the UI (each: 1 or 2+ paths).
#[tauri::command]
pub fn take_launch_args() -> Vec<Vec<String>> {
    std::mem::take(&mut *LAUNCH.lock().unwrap())
}

// ───────────────────────────── files ─────────────────────────────

#[tauri::command]
pub fn path_stat(path: String) -> files::FileStat {
    files::stat(&path)
}

#[tauri::command]
pub async fn load_file(state: State<'_, AppState>, path: String, encoding: Option<String>) -> Result<files::Loaded, String> {
    let fallback = state.settings.get().fallback_encoding;
    blocking(move || files::load(&path, &fallback, encoding.as_deref())).await
}

#[tauri::command]
pub async fn save_file(req: files::SaveReq) -> Result<files::FileStat, String> {
    blocking(move || files::save(&req)).await
}

#[tauri::command]
pub async fn write_text_file(path: String, text: String) -> Result<(), String> {
    blocking(move || std::fs::write(&path, text).map_err(|e| format!("{path}: {e}"))).await
}

#[derive(Serialize)]
pub struct Bytes {
    /// base64 of the first `max` bytes
    pub data: String,
    pub size: u64,
}

#[tauri::command]
pub async fn read_bytes(path: String, max: u64) -> Result<Bytes, String> {
    blocking(move || {
        let (buf, size) = files::read_head(&path, max)?;
        Ok(Bytes { data: base64::engine::general_purpose::STANDARD.encode(buf), size })
    })
    .await
}

#[tauri::command]
pub async fn binary_summary(left: String, right: String) -> Result<files::BinSummary, String> {
    blocking(move || files::binary_summary(&left, &right)).await
}

// ───────────────────────────── diff ─────────────────────────────

#[tauri::command]
pub async fn diff_text(left: Vec<String>, right: Vec<String>, opts: diff::DiffOpts) -> Result<diff::DiffResult, String> {
    blocking(move || Ok(diff::diff_lines(&left, &right, &opts))).await
}

#[tauri::command]
pub async fn unified_patch(left: Vec<String>, right: Vec<String>, left_name: String, right_name: String, context: usize) -> Result<String, String> {
    blocking(move || Ok(diff::unified(&left, &right, &left_name, &right_name, context))).await
}

// ───────────────────────────── folders ─────────────────────────────

#[tauri::command]
pub async fn compare_dirs(left: String, right: String, opts: dirs::DirOpts) -> Result<dirs::DirResult, String> {
    blocking(move || dirs::compare(&left, &right, &opts)).await
}

#[tauri::command]
pub fn cancel_compare() {
    dirs::CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Files compared so far by the running folder comparison.
#[tauri::command]
pub fn compare_progress() -> u64 {
    dirs::PROGRESS.load(std::sync::atomic::Ordering::Relaxed)
}

#[tauri::command]
pub async fn copy_entry(from: String, to: String) -> Result<(), String> {
    blocking(move || dirs::copy_entry(&from, &to)).await
}

// ───────────────────────────── shell helpers ─────────────────────────────

use std::process::Command as Proc;

fn spawn(cmd: &mut Proc) -> Result<(), String> {
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Shows a file (selected) or a folder in the system file manager.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let is_file = Path::new(&path).is_file();
    #[cfg(windows)]
    {
        let p = path.replace('/', "\\");
        let mut cmd = Proc::new("explorer");
        if is_file { cmd.arg(format!("/select,{p}")) } else { cmd.arg(&p) };
        spawn(&mut cmd)
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Proc::new("open");
        if is_file { cmd.args(["-R", &path]) } else { cmd.arg(&path) };
        spawn(&mut cmd)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        // xdg-open cannot select a file: open its folder.
        let dir = if is_file { Path::new(&path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or(path) } else { path };
        spawn(Proc::new("xdg-open").arg(dir))
    }
}

/// Opens a file with its default application.
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    #[cfg(windows)]
    return spawn(Proc::new("explorer").arg(path.replace('/', "\\")));
    #[cfg(target_os = "macos")]
    return spawn(Proc::new("open").arg(&path));
    #[cfg(not(any(windows, target_os = "macos")))]
    return spawn(Proc::new("xdg-open").arg(&path));
}

/// Opens a web page in the default browser (http(s) only).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err(tr("Érvénytelen webcím.", "Invalid web address."));
    }
    #[cfg(windows)]
    return spawn(Proc::new("rundll32").args(["url.dll,FileProtocolHandler", &url]));
    #[cfg(target_os = "macos")]
    return spawn(Proc::new("open").arg(&url));
    #[cfg(not(any(windows, target_os = "macos")))]
    return spawn(Proc::new("xdg-open").arg(&url));
}

// ───────────────────────────── git difftool integration ─────────────────────────────

fn git_cmd() -> Proc {
    let mut c = Proc::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Path of this executable, as git should start it.
#[tauri::command]
pub fn exe_path() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Registers DiffStar as git's diff tool (`git difftool`), in the global config.
#[tauri::command]
pub async fn setup_git_difftool() -> Result<String, String> {
    blocking(|| {
        let exe = exe_path().replace('\\', "/");
        let cmd = format!("\"{exe}\" \"$LOCAL\" \"$REMOTE\"");
        let sets: [(&str, &str); 4] = [
            ("diff.tool", "diffstar"),
            ("difftool.diffstar.cmd", &cmd),
            ("difftool.prompt", "false"),
            ("difftool.diffstar.trustExitCode", "false"),
        ];
        for (k, v) in sets {
            let out = git_cmd().args(["config", "--global", k, v]).output().map_err(|e| {
                tr(&format!("A git nem indítható: {e}"), &format!("Could not start git: {e}"))
            })?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
        }
        Ok(cmd)
    })
    .await
}

// ───────────────────────────── AI ─────────────────────────────

#[derive(Serialize)]
pub struct AiResult {
    pub text: String,
    pub truncated: bool,
}

/// Earlier questions and answers of the AI panel, for follow-up questions.
#[derive(serde::Deserialize, Default)]
pub struct Turn {
    pub q: String,
    pub a: String,
}

fn ai_user(context: String, history: &[Turn], question: Option<String>, default_ask: &str) -> String {
    let mut user = context;
    for t in history {
        user.push_str("\n\nEarlier question: ");
        user.push_str(if t.q.is_empty() { default_ask } else { &t.q });
        user.push_str("\nYour earlier answer:\n");
        user.push_str(&t.a);
    }
    match question.filter(|q| !q.trim().is_empty()) {
        Some(q) => {
            user.push_str("\n\nFollow-up question: ");
            user.push_str(&q);
        }
        None => {
            user.push_str("\n\n");
            user.push_str(default_ask);
        }
    }
    user
}

async fn ai_run(cfg: &Settings, system: String, user: String) -> Result<String, String> {
    ai::complete(ai::AiRequest {
        provider: &cfg.ai_provider,
        api_key: cfg.ai_key(),
        model: cfg.ai_model_id(),
        system,
        user,
        effort: "medium",
        max_tokens: 16000,
    })
    .await
}

/// Explains the differences of two texts (sent as a unified diff) and gives advice.
#[tauri::command]
pub async fn ai_explain(
    state: State<'_, AppState>,
    left: Vec<String>,
    right: Vec<String>,
    left_name: String,
    right_name: String,
    question: Option<String>,
    history: Option<Vec<Turn>>,
) -> Result<AiResult, String> {
    let cfg = state.settings.get();
    let (ln, rn) = (left_name.clone(), right_name.clone());
    let patch = blocking(move || Ok(diff::unified(&left, &right, &ln, &rn, 5))).await?;
    if patch.trim().is_empty() {
        return Err(tr("Nincs mit elemezni: a két oldal azonos.", "Nothing to analyse: the two sides are identical."));
    }
    let (patch, truncated) = ai::cut_diff(&patch, &cfg.ai_provider);
    let mut ctx = format!("LEFT: {left_name}\nRIGHT: {right_name}\n\n<diff>\n{patch}\n</diff>\n");
    if truncated {
        ctx.push_str("\nNote: the diff was cut because of its size; say which parts you could not see.\n");
    }
    let user = ai_user(ctx, &history.unwrap_or_default(), question, "Explain these differences and give advice using the default structure.");
    let text = ai_run(&cfg, ai::explain_system(&cfg.ai_language), user).await?;
    Ok(AiResult { text, truncated })
}

/// Explains a folder comparison: the UI sends a text listing of the result
/// and the relative paths of changed files; their text diffs are added here.
#[tauri::command]
pub async fn ai_folder(
    state: State<'_, AppState>,
    left: String,
    right: String,
    summary: String,
    changed: Vec<String>,
    question: Option<String>,
    history: Option<Vec<Turn>>,
) -> Result<AiResult, String> {
    let cfg = state.settings.get();
    let fallback = cfg.fallback_encoding.clone();
    let budget = if cfg.ai_provider == "deepseek" { 120_000 } else { 300_000 };
    let (l, r) = (left.clone(), right.clone());
    let diffs = blocking(move || {
        let mut out = String::new();
        for rel in changed.iter().take(60) {
            if out.len() > budget {
                out.push_str("\n(further diffs omitted because of their size)\n");
                break;
            }
            let lp = Path::new(&l).join(rel);
            let rp = Path::new(&r).join(rel);
            let small = |p: &Path| std::fs::metadata(p).map(|m| m.len() < 400_000).unwrap_or(false);
            if !small(&lp) || !small(&rp) {
                continue;
            }
            let (Ok(a), Ok(b)) = (files::load(&lp.to_string_lossy(), &fallback, None), files::load(&rp.to_string_lossy(), &fallback, None)) else { continue };
            if a.kind != "text" || b.kind != "text" {
                continue;
            }
            let p = diff::unified(&a.lines, &b.lines, &format!("LEFT/{rel}"), &format!("RIGHT/{rel}"), 2);
            out.push_str(&p.chars().take(40_000).collect::<String>());
            out.push('\n');
        }
        Ok(out)
    })
    .await?;
    let (summary, truncated) = ai::cut_diff(&summary, &cfg.ai_provider);
    let ctx = format!("LEFT folder: {left}\nRIGHT folder: {right}\n\n<comparison>\n{summary}\n</comparison>\n\n<diffs>\n{diffs}</diffs>\n");
    let user = ai_user(ctx, &history.unwrap_or_default(), question, "Summarise this folder comparison and give advice using the default structure.");
    let text = ai_run(&cfg, ai::folder_system(&cfg.ai_language), user).await?;
    Ok(AiResult { text, truncated })
}

/// Settings → AI → Test: a tiny request with the values typed in the dialog.
#[tauri::command]
pub async fn ai_test(provider: String, api_key: String, model: String) -> Result<String, String> {
    let started = std::time::Instant::now();
    let text = ai::complete(ai::AiRequest {
        provider: &provider,
        api_key: &api_key,
        model: &model,
        system: "You are a connection test. Answer with exactly: OK".to_string(),
        user: "Connection test. Answer with exactly: OK".to_string(),
        effort: "low",
        max_tokens: 200,
    })
    .await?;
    let first: String = text.lines().next().unwrap_or("").chars().take(80).collect();
    Ok(format!("{model} · {} ms · „{first}”", started.elapsed().as_millis()))
}

// ───────────────────────────── about ─────────────────────────────

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub tauri: String,
    pub settings_path: String,
    pub os: String,
    pub exe: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        tauri: tauri::VERSION.to_string(),
        settings_path: state.settings.path.to_string_lossy().into_owned(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        exe: exe_path(),
    }
}

// ───────────────────────────── splash screen / window ─────────────────────────────

static SPLASH_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What is remembered of the main window: everything but the visibility
/// (the main window must stay hidden until the splash is over).
pub fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE
}

/// How long the splash screen is shown; the main window appears after it.
pub const SPLASH_TIME: std::time::Duration = std::time::Duration::from_millis(2200);

/// Creates the main window (hidden: `create: false` + `visible: false` in
/// tauri.conf.json), after the splash: two WebView2 windows created at the
/// same moment sometimes left the main one without a page.
pub fn create_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("no 'main' window in tauri.conf.json")?;
    tauri::WebviewWindowBuilder::from_config(app, &cfg)
        .and_then(|b| b.build())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Shows the main window and closes the splash (only the first call counts).
pub fn finish_splash(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(main) = app.get_webview_window("main") else {
        return; // keep the splash: closing the last window would quit the app
    };
    if SPLASH_DONE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let _ = main.show();
    {
        use tauri_plugin_window_state::WindowExt;
        let _ = main.restore_state(window_state_flags());
    }
    let _ = main.set_focus();
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
}

/// Zoom of the whole page (Ctrl + / Ctrl - / Ctrl 0, Ctrl + mouse wheel).
#[tauri::command]
pub fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    window.set_zoom(scale.clamp(0.5, 3.0)).map_err(|e| e.to_string())
}

/// Text on the system clipboard (read here: navigator.clipboard.readText()
/// makes the WebView ask the user for permission).
#[tauri::command]
pub fn clipboard_text() -> Result<String, String> {
    arboard::Clipboard::new().and_then(|mut c| c.get_text()).map_err(|e| e.to_string())
}

pub fn save_window_state(app: &tauri::AppHandle) {
    use tauri_plugin_window_state::AppHandleExt;
    let _ = app.save_window_state(window_state_flags());
}

/// Saves the window state shortly after the last move/resize.
pub fn save_window_state_later(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static LAST: AtomicU64 = AtomicU64::new(0);
    static PENDING: AtomicBool = AtomicBool::new(false);
    let now = || SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    LAST.store(now(), Ordering::SeqCst);
    if PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        while now().saturating_sub(LAST.load(Ordering::SeqCst)) < 1000 {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        PENDING.store(false, Ordering::SeqCst);
        let main = app.clone();
        let _ = app.run_on_main_thread(move || save_window_state(&main));
    });
}

// ───────────────────────────── thumbnails, duplicates ─────────────────────────────

/// A small preview of an image file as a data URL (for the icon views).
#[tauri::command]
pub async fn local_thumb(path: String, size: u32) -> Result<String, String> {
    blocking(move || crate::thumb::make(std::path::Path::new(&path), size)).await
}

/// Files with the same content in the given folders (cancel: `cancel_compare`).
#[tauri::command]
pub async fn find_duplicates(roots: Vec<String>, opts: crate::dups::DupOpts, job: u64) -> Result<crate::dups::DupResult, String> {
    blocking(move || crate::dups::find(&roots, &opts, job)).await
}

/// Stops duplicate search `job` (kept if it has not started yet).
#[tauri::command]
pub fn cancel_dups(job: u64) {
    crate::dups::cancel(job);
}

/// Files looked at so far by duplicate search `job`.
#[tauri::command]
pub fn dups_progress(job: u64) -> u64 {
    crate::dups::progress(job)
}

/// Moves files to the recycle bin.
#[tauri::command]
pub async fn move_to_trash(paths: Vec<String>) -> Result<(), String> {
    blocking(move || crate::dups::to_trash(&paths)).await
}
