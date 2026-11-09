//! Persistent settings (app config dir / settings.json).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Language of backend messages (errors shown in the UI). Set by the UI.
static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_english(on: bool) {
    ENGLISH.store(on, Ordering::Relaxed);
}

/// Picks the Hungarian or the English text.
pub fn tr(hu: &str, en: &str) -> String {
    if ENGLISH.load(Ordering::Relaxed) { en.to_string() } else { hu.to_string() }
}

/// A comparison as remembered in the recent list / session.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Pair {
    /// "text" | "folder"
    pub kind: String,
    pub left: String,
    pub right: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    /// "dark" | "light" | "ai" | "retro" | "modern" | "modern-dark" | "system"
    pub theme: String,
    /// "auto" | "hu" | "en"
    pub ui_language: String,
    pub font_size: u32,
    /// Zoom of the whole UI (1.0 = 100%)
    pub zoom: f64,

    // ── text compare ──
    /// "split" | "unified"
    pub diff_mode: String,
    /// "none" | "change" (amount of whitespace) | "all"
    pub ignore_ws: String,
    pub ignore_case: bool,
    pub wrap: bool,
    /// Show only the differences with `context` lines around them
    pub only_changes: bool,
    pub context: u32,
    /// "patience" | "myers" | "lcs"
    pub algorithm: String,
    /// In-line highlight: "word" | "char"
    pub inline_mode: String,
    pub show_ws: bool,
    /// Encoding for files that are not valid UTF-8 and have no BOM
    pub fallback_encoding: String,

    // ── folder compare ──
    /// "content" | "quick" (size + modification time)
    pub dir_mode: String,
    /// Names skipped in folder compare, separated by `;` (wildcards * ?)
    pub dir_ignore: String,

    pub recent: Vec<Pair>,
    pub session: Vec<Pair>,
    pub session_active: i32,
    pub restore_session: bool,

    // ── AI ──
    /// "anthropic" | "deepseek" | "claude-cli"
    pub ai_provider: String,
    pub claude_cli_path: String,
    pub anthropic_api_key: String,
    pub ai_model: String,
    pub deepseek_api_key: String,
    pub deepseek_model: String,
    /// "hu" | "en"
    pub ai_language: String,

    // ── update ──
    pub update_server: String,
    pub update_check: bool,
    pub update_skip: String,

    /// UI layout state saved by the frontend (panel sizes, last folders...)
    pub ui_state: HashMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            ui_language: "auto".into(),
            font_size: 13,
            zoom: 1.0,
            diff_mode: "split".into(),
            ignore_ws: "none".into(),
            ignore_case: false,
            wrap: false,
            only_changes: false,
            context: 3,
            algorithm: "patience".into(),
            inline_mode: "word".into(),
            show_ws: false,
            fallback_encoding: "windows-1250".into(),
            dir_mode: "content".into(),
            dir_ignore: ".git;.svn;.hg;node_modules;target;Thumbs.db;.DS_Store".into(),
            recent: vec![],
            session: vec![],
            session_active: -1,
            restore_session: true,
            ai_provider: "anthropic".into(),
            claude_cli_path: String::new(),
            anthropic_api_key: String::new(),
            ai_model: "claude-opus-5-5".into(),
            deepseek_api_key: String::new(),
            deepseek_model: "deepseek-flash".into(),
            ai_language: "hu".into(),
            update_server: String::new(),
            update_check: true,
            update_skip: String::new(),
            ui_state: HashMap::new(),
        }
    }
}

impl Settings {
    /// API key of the selected AI provider (the CLI path for "claude-cli").
    pub fn ai_key(&self) -> &str {
        match self.ai_provider.as_str() {
            "deepseek" => &self.deepseek_api_key,
            "claude-cli" => &self.claude_cli_path,
            _ => &self.anthropic_api_key,
        }
    }

    /// Model id of the selected AI provider.
    pub fn ai_model_id(&self) -> &str {
        if self.ai_provider == "deepseek" { &self.deepseek_model } else { &self.ai_model }
    }
}

pub struct SettingsStore {
    pub path: PathBuf,
    pub data: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("settings.json");
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default();
        SettingsStore { path, data: Mutex::new(data) }
    }

    pub fn get(&self) -> Settings {
        self.data.lock().unwrap().clone()
    }

    pub fn save(&self, s: Settings) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())?;
        *self.data.lock().unwrap() = s;
        Ok(())
    }
}
