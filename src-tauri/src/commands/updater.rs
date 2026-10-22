use std::path::Path;

/// Manifest key for a Debian package installation.
///
/// tauri-plugin-updater installs a `.deb` when the running binary belongs to a
/// Debian package and an AppImage otherwise, yet it always looks up the same
/// manifest key (`linux-x86_64`), which lists the AppImage. A `.deb` install
/// therefore gets its own key so that it downloads the matching package.
fn deb_target(arch: &str) -> Option<String> {
    match arch {
        "x86_64" | "aarch64" => Some(format!("linux-{arch}-deb")),
        _ => None,
    }
}

/// Mirrors the plugin's own check: the binary is under /usr on a Debian-based
/// system and dpkg reports a package owning it.
#[cfg(target_os = "linux")]
async fn is_deb_installation(executable: &Path) -> bool {
    if !executable.starts_with("/usr")
        || !Path::new("/var/lib/dpkg").exists()
        || !Path::new("/etc/apt").exists()
    {
        return false;
    }
    tokio::process::Command::new("dpkg")
        .arg("-S")
        .arg(executable)
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
async fn is_deb_installation(_executable: &Path) -> bool {
    false
}

/// Manifest key the updater must use, or `None` for the plugin's default key.
#[tauri::command]
pub async fn get_updater_target() -> Option<String> {
    let executable = std::env::current_exe().ok()?;
    if is_deb_installation(&executable).await {
        deb_target(std::env::consts::ARCH)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deb_installs_use_their_own_manifest_key() {
        assert_eq!(deb_target("x86_64").as_deref(), Some("linux-x86_64-deb"));
        assert_eq!(deb_target("aarch64").as_deref(), Some("linux-aarch64-deb"));
    }

    #[test]
    fn architectures_without_a_deb_use_the_default_key() {
        assert_eq!(deb_target("x86"), None);
        assert_eq!(deb_target("arm"), None);
    }

    #[tokio::test]
    async fn a_binary_outside_system_paths_is_not_a_deb_install() {
        assert!(!is_deb_installation(Path::new("/tmp/Brows3.AppImage")).await);
    }

    #[tokio::test]
    async fn a_system_binary_no_package_owns_is_not_a_deb_install() {
        assert!(!is_deb_installation(Path::new("/usr/bin/brows3-not-installed")).await);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_binary_owned_by_a_debian_package_is_a_deb_install() {
        // dpkg owns its own executable on every Debian-based system.
        if !Path::new("/var/lib/dpkg").exists() || !Path::new("/usr/bin/dpkg").exists() {
            return;
        }
        assert!(is_deb_installation(Path::new("/usr/bin/dpkg")).await);
    }
}
