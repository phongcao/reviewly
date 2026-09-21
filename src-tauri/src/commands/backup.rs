use crate::error::{AppError, AppResult};

/// Review-data bundles are JSON holding whole deep tours, so they run far bigger
/// than the 2 MB the code viewer's `read_file` allows — 20 deep tours across
/// big PRs is comfortably megabytes. Still bounded, so a mis-picked file (a
/// video, a disk image) fails fast instead of being slurped into the webview.
const MAX_BUNDLE_BYTES: u64 = 64_000_000;

/// Write a review-data bundle to a path the user picked in a save dialog.
#[tauri::command]
pub async fn write_bundle(path: String, contents: String) -> AppResult<()> {
    std::fs::write(&path, contents).map_err(|e| AppError::Other(format!("write: {e}")))
}

/// Read a review-data bundle the user picked in an open dialog.
#[tauri::command]
pub async fn read_bundle(path: String) -> AppResult<String> {
    let meta = std::fs::metadata(&path).map_err(|e| AppError::Other(format!("stat: {e}")))?;
    if meta.len() > MAX_BUNDLE_BYTES {
        return Err(AppError::Other("file too large to be a review bundle".into()));
    }
    std::fs::read_to_string(&path).map_err(|e| AppError::Other(format!("read: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pair has to round-trip a bundle far bigger than the code viewer's
    /// 2 MB `read_file` ceiling — that ceiling is exactly why these exist.
    #[tokio::test]
    async fn round_trips_a_bundle_larger_than_the_read_file_cap() {
        let dir = std::env::temp_dir().join("reviewly-backup-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bundle.json").to_string_lossy().into_owned();

        let big = format!(r#"{{"kind":"reviewly.review-data","pad":"{}"}}"#, "x".repeat(4_000_000));
        write_bundle(path.clone(), big.clone()).await.unwrap();
        assert_eq!(read_bundle(path.clone()).await.unwrap(), big);

        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn refuses_a_file_that_is_not_there() {
        let missing = std::env::temp_dir().join("reviewly-nope.json");
        assert!(read_bundle(missing.to_string_lossy().into_owned()).await.is_err());
    }
}
