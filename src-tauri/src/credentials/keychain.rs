use crate::error::{AppError, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const SERVICE_NAME: &str = "brows3-credentials";
const FALLBACK_SECRETS_FILE: &str = "secrets.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretsData {
    #[serde(default)]
    secrets: HashMap<String, String>,
}

/// Secure credential storage using OS keychain
pub struct KeychainStorage {
    app_name: String,
    fallback_path: PathBuf,
}

impl KeychainStorage {
    pub fn new(app_name: &str, config_dir: &Path) -> Self {
        Self {
            app_name: app_name.to_string(),
            fallback_path: config_dir.join(FALLBACK_SECRETS_FILE),
        }
    }
    
    fn get_entry(&self, key: &str) -> Result<Entry> {
        Entry::new(SERVICE_NAME, &format!("{}-{}", self.app_name, key))
            .map_err(|e| AppError::KeychainError(e.to_string()))
    }

    fn read_fallback_secrets(&self) -> Result<SecretsData> {
        if !self.fallback_path.exists() {
            return Ok(SecretsData::default());
        }

        let content = fs::read_to_string(&self.fallback_path)?;
        if content.trim().is_empty() {
            return Ok(SecretsData::default());
        }

        serde_json::from_str(&content)
            .map_err(|e| AppError::SerializationError(format!("Failed to parse fallback secrets store: {}", e)))
    }

    fn write_fallback_secrets(&self, data: &SecretsData) -> Result<()> {
        if let Some(parent) = self.fallback_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(data)?;
        fs::write(&self.fallback_path, content)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::Permissions::from_mode(0o600);
            let _ = fs::set_permissions(&self.fallback_path, permissions);
        }

        Ok(())
    }

    fn store_fallback(&self, key: &str, secret: &str) -> Result<()> {
        let mut data = self.read_fallback_secrets()?;
        data.secrets.insert(key.to_string(), secret.to_string());
        self.write_fallback_secrets(&data)
    }

    fn get_fallback(&self, key: &str) -> Result<String> {
        let data = self.read_fallback_secrets()?;
        data.secrets
            .get(key)
            .cloned()
            .ok_or_else(|| AppError::KeychainError("Secret not found in fallback storage".to_string()))
    }

    fn delete_fallback(&self, key: &str) -> Result<()> {
        let mut data = self.read_fallback_secrets()?;
        data.secrets.remove(key);
        self.write_fallback_secrets(&data)
    }
    
    /// Store a secret in the OS keychain
    pub fn store(&self, key: &str, secret: &str) -> Result<()> {
        let entry = self.get_entry(key)?;
        match entry.set_password(secret) {
            Ok(()) => {
                let _ = self.delete_fallback(key);
                Ok(())
            }
            Err(err) => {
                log::warn!("Native keychain store failed for '{}', falling back to local secrets file: {}", key, err);
                self.store_fallback(key, secret)
            }
        }
    }
    
    /// Retrieve a secret from the OS keychain
    pub fn get(&self, key: &str) -> Result<String> {
        let entry = self.get_entry(key)?;
        match entry.get_password() {
            Ok(secret) => Ok(secret),
            Err(err) => {
                log::warn!("Native keychain read failed for '{}', trying local secrets file: {}", key, err);
                self.get_fallback(key)
            }
        }
    }
    
    /// Delete a secret from the OS keychain
    pub fn delete(&self, key: &str) -> Result<()> {
        let entry = self.get_entry(key)?;
        if let Err(err) = entry.delete_credential() {
            log::warn!("Native keychain delete failed for '{}', clearing local fallback if present: {}", key, err);
        }
        let _ = self.delete_fallback(key);
        Ok(())
    }
    
    /// Check if a secret exists in the keychain
    pub fn exists(&self, key: &str) -> bool {
        self.get(key).is_ok()
    }
}
