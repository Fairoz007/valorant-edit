use anyhow::{bail, Result};
use std::{
    env,
    path::{Path, PathBuf},
};
pub fn find(env_var: &str, exe: &str, bundled: &Path) -> Result<PathBuf> {
    find_in(env_var, exe, &[bundled.to_owned()])
}
/// Like [`find`], with several bundled folders tried in order (each one and its `bin/`) before PATH.
pub fn find_in(env_var: &str, exe: &str, bundled: &[PathBuf]) -> Result<PathBuf> {
    if let Some(value) = env::var_os(env_var).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(&value);
        if path.exists() {
            return Ok(path);
        }
        bail!("{exe} not found: {env_var}={}", value.to_string_lossy());
    }
    let name = if cfg!(windows) {
        format!("{exe}.exe")
    } else {
        exe.into()
    };
    if let Some(value) = env::var_os("ADITOR_FFMPEG").filter(|v| !v.is_empty()) {
        let sibling = Path::new(&value)
            .parent()
            .unwrap_or(Path::new(""))
            .join(&name);
        if sibling.exists() {
            return Ok(sibling);
        }
    }
    for root in bundled {
        for dir in [root.clone(), root.join("bin")] {
            let candidate = dir.join(&name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    bail!("{exe} not found (set {env_var}, place in ffmpeg/ or add to PATH)")
}
/// Folders searched after the environment overrides and before PATH.
/// Debug builds (tests, `cargo run`) also use the pinned FFmpeg that `scripts/fetch-ffmpeg.ps1` puts in
/// `<repo>/build/ffmpeg`, so the suites never depend on whatever FFmpeg happens to be on PATH.
/// Release builds never look there: the app passes ADITOR_FFMPEG / ADITOR_FFPROBE.
pub fn bundled_dirs() -> Vec<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut dirs = vec![manifest.join("ffmpeg")];
    if cfg!(debug_assertions) {
        dirs.push(manifest.join("..").join("build").join("ffmpeg"));
    }
    dirs
}
pub fn ffmpeg() -> Result<PathBuf> {
    find_in("ADITOR_FFMPEG", "ffmpeg", &bundled_dirs())
}
pub fn ffprobe() -> Result<PathBuf> {
    find_in("ADITOR_FFPROBE", "ffprobe", &bundled_dirs())
}
