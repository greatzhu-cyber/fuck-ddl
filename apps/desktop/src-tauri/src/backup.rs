use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tauri::{AppHandle, Manager};

const MAX_BACKUP_BYTES: usize = 2 * 1024 * 1024;
const MAX_BACKUPS: usize = 14;

fn valid_backup_document(value: &Value) -> bool {
    let Some(document) = value.as_object() else {
        return false;
    };
    if document.get("format").and_then(Value::as_str) != Some("fuck-ddl-backup")
        || document.get("version").and_then(Value::as_u64) != Some(1)
    {
        return false;
    }
    let Some(state) = document.get("state").and_then(Value::as_object) else {
        return false;
    };
    !state.is_empty()
        && state.iter().all(|(key, value)| {
            key.starts_with("fuck-ddl:v1:")
                && value
                    .as_str()
                    .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok())
                    .and_then(|entry| entry.get("version").and_then(Value::as_u64))
                    == Some(1)
        })
}

fn backup_file_name(now: SystemTime) -> String {
    let seconds = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("fuck-ddl-local-{seconds}.json")
}

fn backup_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("backups"))
        .map_err(|error| format!("backup-directory-failed:{error}"))
}

fn retain_recent_backups(directory: &Path) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("backup-read-failed:{error}"))?
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("fuck-ddl-local-")
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    let overflow = entries.len().saturating_sub(MAX_BACKUPS);
    for entry in entries.into_iter().take(overflow) {
        fs::remove_file(entry.path()).map_err(|error| format!("backup-prune-failed:{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn save_local_backup(app: AppHandle, backup_json: String) -> Result<String, String> {
    if backup_json.len() > MAX_BACKUP_BYTES {
        return Err("backup-too-large".to_string());
    }
    let document = serde_json::from_str::<Value>(&backup_json)
        .map_err(|_| "backup-json-invalid".to_string())?;
    if !valid_backup_document(&document) {
        return Err("backup-document-invalid".to_string());
    }
    let directory = backup_directory(&app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("backup-create-failed:{error}"))?;
    let path = directory.join(backup_file_name(SystemTime::now()));
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, backup_json).map_err(|error| format!("backup-write-failed:{error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("backup-commit-failed:{error}"))?;
    retain_recent_backups(&directory)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_versioned_local_business_state() {
        let valid = serde_json::json!({
            "format": "fuck-ddl-backup",
            "version": 1,
            "state": {"fuck-ddl:v1:tasks": "{\"version\":1,\"value\":[]}"}
        });
        assert!(valid_backup_document(&valid));
        assert!(!valid_backup_document(&serde_json::json!({
            "format": "fuck-ddl-backup",
            "version": 1,
            "state": {"fuck-ddl:auth": "secret"}
        })));
    }

    #[test]
    fn generated_names_do_not_contain_user_data() {
        assert_eq!(
            backup_file_name(UNIX_EPOCH + std::time::Duration::from_secs(42)),
            "fuck-ddl-local-42.json"
        );
    }
}
