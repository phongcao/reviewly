use crate::error::{AppError, AppResult};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Review-data bundles are JSON holding whole deep tours, so they run far bigger
/// than the 2 MB the code viewer's `read_file` allows — 20 deep tours across
/// big PRs is comfortably megabytes. Still bounded, so a mis-picked file (a
/// video, a disk image) fails fast instead of being slurped into the webview.
const MAX_BUNDLE_BYTES: u64 = 64_000_000;

/// What the webview may save. Each kind fixes its dialog and file extension, so
/// the page names *what* it exports, never *where*: the path comes from a
/// dialog the backend shows, and a script in the page can't aim a write at
/// `~/.zshrc` or a LaunchAgent.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ExportKind {
    /// A review-data bundle (JSON).
    Bundle,
    /// An exported HTML review report.
    Report,
}

impl ExportKind {
    fn title(self) -> &'static str {
        match self {
            Self::Bundle => "Export review data",
            Self::Report => "Export review report",
        }
    }
    fn filter(self) -> &'static str {
        match self {
            Self::Bundle => "Reviewly review data",
            Self::Report => "HTML page",
        }
    }
    fn extension(self) -> &'static str {
        match self {
            Self::Bundle => "json",
            Self::Report => "html",
        }
    }
}

/// `path` with `kind`'s extension, added when the user typed a name without it.
/// Some platforms' save dialogs don't enforce the filter.
fn with_extension(path: PathBuf, kind: ExportKind) -> PathBuf {
    let ext = kind.extension();
    match path.extension() {
        Some(e) if e.eq_ignore_ascii_case(ext) => path,
        _ => {
            let mut s = path.into_os_string();
            s.push(".");
            s.push(ext);
            PathBuf::from(s)
        }
    }
}

/// Ask where to save, then write `contents` there. `default_name` only fills
/// the dialog's name box (directories are stripped). Returns the file name
/// written, or None when the user cancelled.
#[tauri::command]
pub async fn export_file(
    app: AppHandle,
    kind: ExportKind,
    default_name: String,
    contents: String,
) -> AppResult<Option<String>> {
    let name = Path::new(&default_name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(kind.title())
            .add_filter(kind.filter(), &[kind.extension()])
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("dialog: {e}")))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| AppError::Other(format!("path: {e}")))?;
    let path = with_extension(path, kind);
    write_to(&path, &contents)?;
    Ok(Some(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
}

/// Ask for a review-data bundle to import and return its text, or None when
/// the user cancelled. Like `export_file`, the path never comes from the page.
#[tauri::command]
pub async fn import_bundle(app: AppHandle) -> AppResult<Option<String>> {
    let kind = ExportKind::Bundle;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Import review data")
            .add_filter(kind.filter(), &[kind.extension()])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Other(format!("dialog: {e}")))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| AppError::Other(format!("path: {e}")))?;
    read_from(&path).map(Some)
}

fn write_to(path: &Path, contents: &str) -> AppResult<()> {
    std::fs::write(path, contents).map_err(|e| AppError::Other(format!("write: {e}")))
}

fn read_from(path: &Path) -> AppResult<String> {
    let meta = std::fs::metadata(path).map_err(|e| AppError::Other(format!("stat: {e}")))?;
    if meta.len() > MAX_BUNDLE_BYTES {
        return Err(AppError::Other("file too large to be a review bundle".into()));
    }
    std::fs::read_to_string(path).map_err(|e| AppError::Other(format!("read: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pair has to round-trip a bundle far bigger than the code viewer's
    /// 2 MB `read_file` ceiling — that ceiling is exactly why these exist.
    #[test]
    fn round_trips_a_bundle_larger_than_the_read_file_cap() {
        let dir = std::env::temp_dir().join("reviewly-backup-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bundle.json");

        let big = format!(r#"{{"kind":"reviewly.review-data","pad":"{}"}}"#, "x".repeat(4_000_000));
        write_to(&path, &big).unwrap();
        assert_eq!(read_from(&path).unwrap(), big);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn refuses_a_file_that_is_not_there() {
        let missing = std::env::temp_dir().join("reviewly-nope.json");
        assert!(read_from(&missing).is_err());
    }

    #[test]
    fn a_save_always_gets_its_kinds_extension() {
        let p = |s: &str, k| with_extension(PathBuf::from(s), k);
        assert_eq!(p("/d/a.json", ExportKind::Bundle), PathBuf::from("/d/a.json"));
        assert_eq!(p("/d/a.JSON", ExportKind::Bundle), PathBuf::from("/d/a.JSON"));
        assert_eq!(p("/d/a", ExportKind::Bundle), PathBuf::from("/d/a.json"));
        assert_eq!(p("/d/.zshrc", ExportKind::Report), PathBuf::from("/d/.zshrc.html"));
        assert_eq!(p("/d/r.json", ExportKind::Report), PathBuf::from("/d/r.json.html"));
    }
}
