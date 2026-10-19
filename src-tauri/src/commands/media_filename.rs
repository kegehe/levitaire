use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};

fn normalized_extension(extension: &str) -> String {
    let extension = extension.trim().trim_start_matches('.');
    if extension.is_empty() {
        "bin".to_string()
    } else {
        extension.to_ascii_lowercase()
    }
}

fn normalized_kind(kind: &str) -> String {
    let kind = kind
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if kind.is_empty() {
        "capture".to_string()
    } else {
        kind
    }
}

fn filename_at(kind: &str, extension: &str, now: DateTime<Local>) -> String {
    format!(
        "{}_{}.{}",
        normalized_kind(kind),
        now.format("%Y%m%d_%H%M%S_%3f"),
        normalized_extension(extension)
    )
}

pub(crate) fn timestamped_filename(kind: &str, extension: &str) -> String {
    filename_at(kind, extension, Local::now())
}

pub(crate) fn timestamped_filename_for_template(
    template: &str,
    fallback_kind: &str,
    fallback_extension: &str,
) -> String {
    let kind = Path::new(template)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_kind);
    let extension = Path::new(template)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_extension);
    filename_at(&kind, extension, Local::now())
}

pub(crate) fn unique_path(directory: &Path, kind: &str, extension: &str) -> PathBuf {
    unique_path_from_filename(directory, filename_at(kind, extension, Local::now()))
}

fn unique_path_from_filename(directory: &Path, base: String) -> PathBuf {
    let base_path = directory.join(&base);
    if !base_path.exists() {
        return base_path;
    }

    let (stem, extension) = base
        .rsplit_once('.')
        .expect("timestamped media filename always has an extension");
    for index in 2..=10_000 {
        let candidate = directory.join(format!("{stem}_{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("{stem}_{}.{}", std::process::id(), extension))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn formats_timestamped_filename_with_milliseconds() {
        let now = Local.with_ymd_and_hms(2026, 10, 16, 14, 30, 25).unwrap()
            + chrono::Duration::milliseconds(123);
        assert_eq!(
            filename_at("screenshot", ".PNG", now),
            "screenshot_20261016_143025_123.png"
        );
    }

    #[test]
    fn chooses_a_suffix_when_the_timestamped_name_exists() {
        let directory =
            std::env::temp_dir().join(format!("levitaire-media-name-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let base = filename_at("recording", "mp4", Local::now());
        let first = unique_path_from_filename(&directory, base.clone());
        std::fs::write(&first, []).unwrap();
        let second = unique_path_from_filename(&directory, base);
        assert_ne!(first, second);
        assert!(second
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("_2."));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn normalizes_extension_without_a_leading_dot() {
        let now = Local::now();
        assert!(filename_at("long_screenshot", " .JpG", now).ends_with(".jpg"));
    }

    #[test]
    fn derives_a_safe_kind_from_an_existing_template() {
        let filename = timestamped_filename_for_template("my sketch.png", "screenshot", "png");
        assert!(filename.starts_with("my_sketch_"));
        assert!(filename.ends_with(".png"));
    }

    #[test]
    fn sanitizes_path_separators_in_the_kind() {
        let filename = filename_at("../nested\\capture", "png", Local::now());
        assert!(!filename.contains('/') && !filename.contains('\\'));
        assert!(filename.starts_with("___nested_capture_"));
    }
}
