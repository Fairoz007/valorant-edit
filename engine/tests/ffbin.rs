mod common;
use aditor::ffbin;
use common::TempDir;
#[test]
fn debug_builds_search_the_pinned_build_folder_before_path() {
    let dirs = ffbin::bundled_dirs();
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    assert_eq!(dirs[0], manifest.join("ffmpeg"));
    // Tests run a debug build, so the pinned FFmpeg from scripts/fetch-ffmpeg.ps1 is found without PATH.
    assert_eq!(dirs[1], manifest.join("..").join("build").join("ffmpeg"));
}
#[test]
fn find_in_tries_bundled_folders_in_order() {
    // No PATH or environment changes here, so this runs in-process; the override variable is one nobody sets.
    let d = TempDir::new();
    let exe = if cfg!(windows) { "tool.exe" } else { "tool" };
    let (first, second) = (d.0.join("first"), d.0.join("second"));
    std::fs::create_dir_all(first.join("bin")).unwrap();
    std::fs::create_dir_all(second.join("bin")).unwrap();
    let dirs = [first.clone(), second.clone()];
    let var = "ADITOR_FFBIN_TEST_UNSET_OVERRIDE";
    std::fs::write(second.join("bin").join(exe), []).unwrap();
    assert_eq!(
        ffbin::find_in(var, "tool", &dirs).unwrap(),
        second.join("bin").join(exe)
    );
    std::fs::write(first.join("bin").join(exe), []).unwrap();
    assert_eq!(
        ffbin::find_in(var, "tool", &dirs).unwrap(),
        first.join("bin").join(exe)
    );
}
#[test]
fn explicit_missing_override_and_lookup_order() {
    // Run environment-sensitive checks in a child so parallel ffmpeg tests keep their environment.
    if std::env::var_os("ADITOR_FFBIN_TEST_CHILD").is_some() {
        let d = TempDir::new();
        let exe = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        std::env::set_var("ADITOR_FFMPEG", d.0.join("missing"));
        assert!(ffbin::ffmpeg()
            .unwrap_err()
            .to_string()
            .contains("ADITOR_FFMPEG="));
        let custom = d.0.join(exe);
        std::fs::write(&custom, []).unwrap();
        std::env::set_var("ADITOR_FFMPEG", &custom);
        assert_eq!(ffbin::ffmpeg().unwrap(), custom);
        std::env::remove_var("ADITOR_FFPROBE");
        let sibling = d.0.join(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
        std::fs::write(&sibling, []).unwrap();
        assert_eq!(ffbin::ffprobe().unwrap(), sibling);
        std::env::remove_var("ADITOR_FFMPEG");
        std::env::set_var("PATH", &d.0);
        let bundled = d.0.join("bundled");
        std::fs::create_dir_all(bundled.join("bin")).unwrap();
        let bundled_probe = bundled.join(sibling.file_name().unwrap());
        std::fs::write(&bundled_probe, []).unwrap();
        assert_eq!(
            ffbin::find("ADITOR_FFPROBE", "ffprobe", &bundled).unwrap(),
            bundled_probe
        );
        std::fs::remove_file(&bundled_probe).unwrap();
        let bin_probe = bundled.join("bin").join(sibling.file_name().unwrap());
        std::fs::write(&bin_probe, []).unwrap();
        assert_eq!(
            ffbin::find("ADITOR_FFPROBE", "ffprobe", &bundled).unwrap(),
            bin_probe
        );
        std::fs::remove_file(&bin_probe).unwrap();
        assert_eq!(
            ffbin::find("ADITOR_FFPROBE", "ffprobe", &bundled).unwrap(),
            sibling
        );
        std::fs::remove_file(sibling).unwrap();
        assert_eq!(
            ffbin::find("ADITOR_FFPROBE", "ffprobe", &bundled)
                .unwrap_err()
                .to_string(),
            "ffprobe not found (set ADITOR_FFPROBE, place in ffmpeg/ or add to PATH)"
        );
        return;
    }
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "explicit_missing_override_and_lookup_order",
            "--nocapture",
        ])
        .env("ADITOR_FFBIN_TEST_CHILD", "1")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
