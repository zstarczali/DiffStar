<p align="center">
  <img src="assets/icon.svg" alt="DiffStar logo" width="200" height="200">
</p>

<h1 align="center">DiffStar</h1>

DiffStar is a file and folder comparison tool with a **Tauri 2 and Rust** backend. It is the sibling of [GitStar](https://github.com/zstarczali/GitStar) and shares its themes, dialogs and AI setup.

Current version **0.2.1**. See [What's new](whatsnew.txt) for the release history.

## Features

- **Text comparison** — Side-by-side or unified view with **word- or character-level highlighting**, Patience / Myers / LCS algorithms, changed lines paired by similarity, minimap, and folding of identical parts with adjustable context. Ignore whitespace (all or amount) and case, show whitespace, wrap lines.
- **Merging and editing** — Copy a difference to the left or right (Alt+← / Alt+→), copy all differences, edit lines in place or a whole side as text, undo / redo, and save with the original encoding, BOM and line endings. Files changed on disk are reloaded.
- **Encodings** — UTF-8, UTF-16 (BOM), and a fallback 8-bit encoding (Windows-1250 by default) for other files; reload or save with another encoding, change the line ending.
- **Folder comparison** — Compare whole trees by content (byte by byte) or by size and date, filter identical / different / left-only / right-only entries, copy files or folders to the other side, and open file pairs in a new tab. Three views: **details tree, small icons and large icons with image previews** (left and right picture side by side).
- **Duplicate finder** — Files with the same content in one or two folders, also inside one folder (size → partial hash → full SHA-256). Groups ordered by reclaimable space, image previews, quick selection (keep the oldest / newest / shortest path, select one side), and moving the selected copies to the recycle bin. A group can never lose all copies.
- **Images and binaries** — Images side by side, blended, with a swipe slider or as a pixel difference with tolerance; other binary files in a hex view with the differing bytes highlighted.
- **AI explanation and advice** — The AI button explains the differences of two files or two folders, points out risks, and advises which side to keep and how to merge. Ask follow-up questions in the panel. Only the diff is sent to the selected provider.
- **Find, go to line, export** — Search both sides, jump to a line, save an HTML report or a unified `.patch`.
- **Tabs and session** — Several comparisons in tabs, restored at the next start; recent comparisons on the welcome page; drag and drop one or two files or folders onto the window.
- **git difftool** — One click in **Settings → Git** sets DiffStar as the global `git difftool`; a running DiffStar receives new pairs as tabs.
- **Themes** — Dark, light, AI neon, retro, modern, modern dark, or system, as in GitStar. Zoom with Ctrl + / Ctrl − / Ctrl 0.
- **Self-update** — Looks for a newer installer in `downloads/DiffStar/` on the update server (default `https://www.c64va.pro/`).
- **English and Hungarian** interface.

## Running from source

Install stable Rust and Node.js. On Windows, WebView2 is required and comes with Windows 11. On Linux, install the Tauri system dependencies, including WebKitGTK 4.1.

```bash
npm install
npm run dev
```

To build an NSIS installer locally on Windows (written to `src-tauri/target/release/bundle`):

```bash
npm run build -- --bundles nsis
```

Command line: `DiffStar <left> <right>` compares two files or two folders.

### Building installers with GitHub Actions

The `.github/workflows/build.yml` workflow runs **only when manually triggered** (**Actions → Build installers → Run workflow**, or `gh workflow run build.yml --ref main`). It builds Windows x64 / ARM64 (NSIS), macOS ARM64 / x64 (`.dmg`) and Linux x64 (`.deb`, `.rpm`, `.AppImage`) installers. **Actions → Publish** uploads the installers of a successful build run, plus `readme.txt`, `whatsnew.txt` and `LICENSE`, to `/www/downloads/DiffStar/` over FTPS; it needs the **FTP_PASSWORD** Actions secret.

The [installation guide](readme.txt) covers every target.

## AI setup

In **Settings → AI → AI provider**, choose **Anthropic Claude (API key)**, **Claude Code CLI (your own login)** or **DeepSeek** — the same options as in GitStar. The API key is stored unencrypted in `settings.json` in the app configuration folder (on Windows `%APPDATA%\hu.diffstar.app\settings.json`).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+O / Ctrl+Shift+O | Compare files / folders |
| Ctrl+N | Compare pasted text |
| Ctrl+Shift+D | Find duplicates |
| Alt+↑ / Alt+↓, Shift+F8 / F8 | Previous / next difference |
| Alt+← / Alt+→ | Copy the current difference to the left / right |
| Ctrl+S | Save modified files |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+F / Ctrl+G | Find / go to line |
| F5 | Reload / compare again |
| Ctrl+W, Ctrl+Tab | Close tab, next tab |
| Ctrl+, / F1 | Settings / About |

## Project structure

```text
src-tauri/src/
  diff.rs       Line diff, alignment of changed lines, word/char highlights, unified patch
  files.rs      Loading with encoding / BOM / line-ending detection, safe saving, binary summary
  dirs.rs       Folder tree comparison and copying
  dups.rs       Duplicate finder and recycle bin
  thumb.rs      Image thumbnails (shared with FtpStar)
  ai.rs         AI API calls and prompts
  commands.rs   Tauri commands
www/js/
  app.js        Tabs, toolbar, welcome page, dialogs, settings, AI panel, update
  textview.js   Text comparison view
  folderview.js Folder comparison view (tree and icon views)
  dupview.js    Duplicate finder view
  binview.js    Hex and image comparison
  thumbs.js     Lazy thumbnail loading
  i18n.js, i18n-en.js  Hungarian → English translations
```

## License

DiffStar is freeware: free to download and use, including at work, but it may not be copied, redistributed, published, sold, or modified without the author's written permission. See [LICENSE](LICENSE).

If DiffStar is useful to you, you can support its development with a small [donation](https://www.c64va.pro/register/donate.php).

© 2026 Zsolt Tarczali
