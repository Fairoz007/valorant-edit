//! `aditorrec --foreground <pid>`: one read-only window-manager query for the app's focus guard and in-game overlay.
//! Prints one JSON line and exits. It never opens the game process (no OpenProcess) and changes no window, focus or cursor state.
use serde_json::{json, Value};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic,
};

fn rect(r: RECT) -> Value {
    json!([r.left, r.top, r.right - r.left, r.bottom - r.top])
}

/// Foreground PID, whether it is `game_pid`, whether a D3D app holds exclusive fullscreen, and the game window and monitor rectangles.
pub fn query(game_pid: u32) -> Value {
    // SAFETY: Queries only; every out-parameter is a stack value, and a vanished HWND makes the calls fail harmlessly.
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        let mut pid = 0u32;
        if !hwnd.is_invalid() {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        let game_foreground = game_pid != 0 && pid == game_pid && !IsIconic(hwnd).as_bool();
        // QUNS_RUNNING_D3D_FULL_SCREEN: an exclusive-fullscreen Direct3D app; no other window can be shown over it.
        let state = SHQueryUserNotificationState().ok();
        let exclusive = state == Some(QUNS_RUNNING_D3D_FULL_SCREEN);
        let busy = matches!(state, Some(s) if s == QUNS_BUSY || s == QUNS_PRESENTATION_MODE);
        let (mut window, mut monitor) = (Value::Null, Value::Null);
        if game_foreground {
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                window = rect(r);
            }
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info)
                .as_bool()
            {
                monitor = rect(info.rcMonitor);
            }
        }
        json!({
            "foreground_pid": if pid == 0 { Value::Null } else { json!(pid) },
            "game_foreground": game_foreground,
            "exclusive_fullscreen": exclusive,
            "fullscreen_busy": busy,
            "game_rect": window,
            "monitor_rect": monitor,
        })
    }
}

/// Parses `--foreground <pid>`; None means normal IPC mode.
pub fn requested(args: &[String]) -> Option<u32> {
    let at = args.iter().position(|a| a == "--foreground")?;
    Some(args.get(at + 1).and_then(|v| v.parse().ok()).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_flag_and_tolerates_a_missing_pid() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(requested(&args(&["aditorrec"])), None);
        assert_eq!(
            requested(&args(&["aditorrec", "--foreground", "42"])),
            Some(42)
        );
        assert_eq!(requested(&args(&["aditorrec", "--foreground"])), Some(0));
    }

    #[test]
    fn query_reports_every_field_and_never_matches_pid_zero() {
        let value = query(0);
        for key in [
            "foreground_pid",
            "game_foreground",
            "exclusive_fullscreen",
            "fullscreen_busy",
            "game_rect",
            "monitor_rect",
        ] {
            assert!(value.get(key).is_some(), "{key} missing in {value}");
        }
        assert_eq!(value["game_foreground"], false);
        assert!(value["game_rect"].is_null());
    }
}
