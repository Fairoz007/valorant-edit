//! `aditorrec --foreground <pid>`: one read-only window-manager query for the app's focus guard and in-game overlay.
//! Prints one JSON line and exits. It never opens the game process (no OpenProcess) and changes no window, focus or cursor state.
use serde_json::{json, Value};
use windows::Win32::Foundation::{HWND, RECT};
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    EnumDisplaySettingsW, GetMonitorInfoW, MonitorFromWindow, DEVMODEW, ENUM_CURRENT_SETTINGS,
    ENUM_REGISTRY_SETTINGS, HMONITOR, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
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

/// The window covers the whole monitor (borderless or fullscreen; a normal window leaves part of it uncovered).
fn covers(window: RECT, monitor: RECT) -> bool {
    window.left <= monitor.left
        && window.top <= monitor.top
        && window.right >= monitor.right
        && window.bottom >= monitor.bottom
}

/// Two display modes differ in resolution: the game switched the monitor away from the desktop mode,
/// which only Fullscreen does (for example a stretched 4:3 resolution). Windowed Fullscreen never changes the mode.
fn mode_differs(current: (u32, u32), desktop: (u32, u32)) -> bool {
    current.0 != 0 && desktop.0 != 0 && current != desktop
}

/// Current and saved (desktop) resolution of the monitor, read with EnumDisplaySettingsW. None when either read fails.
fn display_modes(monitor: HMONITOR) -> Option<((u32, u32), (u32, u32))> {
    // SAFETY: Read-only display queries; every structure is initialized with its documented size.
    unsafe {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(monitor, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
            return None;
        }
        let device = PCWSTR(info.szDevice.as_ptr());
        let read = |which| {
            let mut mode = DEVMODEW {
                dmSize: std::mem::size_of::<DEVMODEW>() as u16,
                ..Default::default()
            };
            EnumDisplaySettingsW(device, which, &mut mode)
                .as_bool()
                .then_some((mode.dmPelsWidth, mode.dmPelsHeight))
        };
        Some((read(ENUM_CURRENT_SETTINGS)?, read(ENUM_REGISTRY_SETTINGS)?))
    }
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
        let (mut covers_monitor, mut mode_changed) = (false, false);
        if game_foreground {
            let mut r = RECT::default();
            let have_window = GetWindowRect(hwnd, &mut r).is_ok();
            if have_window {
                window = rect(r);
            }
            let handle = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(handle, &mut info).as_bool() {
                monitor = rect(info.rcMonitor);
                covers_monitor = have_window && covers(r, info.rcMonitor);
            }
            mode_changed = display_modes(handle).is_some_and(|(now, desk)| mode_differs(now, desk));
        }
        json!({
            "foreground_pid": if pid == 0 { Value::Null } else { json!(pid) },
            "game_foreground": game_foreground,
            "exclusive_fullscreen": exclusive,
            "fullscreen_busy": busy,
            "game_rect": window,
            "monitor_rect": monitor,
            "covers_monitor": covers_monitor,
            "display_mode_changed": mode_changed,
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
            "covers_monitor",
            "display_mode_changed",
        ] {
            assert!(value.get(key).is_some(), "{key} missing in {value}");
        }
        assert_eq!(value["game_foreground"], false);
        assert!(value["game_rect"].is_null());
        assert_eq!(value["display_mode_changed"], false);
    }

    #[test]
    fn covers_and_mode_change_rules() {
        let r = |l, t, rr, b| RECT { left: l, top: t, right: rr, bottom: b };
        let monitor = r(0, 0, 2560, 1440);
        assert!(covers(r(0, 0, 2560, 1440), monitor));
        // A window larger than its monitor (seen with VALORANT) still covers it.
        assert!(covers(r(0, 0, 3840, 2160), monitor));
        assert!(!covers(r(-8, -8, 2568, 1400), monitor));
        assert!(!covers(r(100, 100, 1380, 820), monitor));
        assert!(mode_differs((1920, 1440), (2560, 1440)));
        assert!(!mode_differs((2560, 1440), (2560, 1440)));
        assert!(!mode_differs((0, 0), (2560, 1440)));
    }
}
