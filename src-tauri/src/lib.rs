#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::Entry;
use serde::{Deserialize, Serialize};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter,
};
use tauri::{Manager, WebviewWindow};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_autostart::ManagerExt;

const KEYRING_SERVICE: &str = "com.yourcompany.clocky";
const KEYRING_USER: &str = "auth_token";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LocationResult {
    pub lat: f64,
    pub lng: f64,
    pub accuracy: f64,
    pub source: String,
}

#[tauri::command]
fn keychain_save_token(token: String) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("Failed to access keyring: {e}"))?;
        entry
            .set_password(&token)
            .map_err(|e| format!("Failed to store token in keychain: {e}"))?;
        Ok(())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = token;
        Err("Keyring is not available on mobile; using app storage".to_string())
    }
}

#[tauri::command]
fn keychain_get_token() -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("Failed to access keyring: {e}"))?;
        match entry.get_password() {
            Ok(pass) => Ok(Some(pass)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Failed to retrieve token from keychain: {e}")),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Ok(None)
    }
}

#[tauri::command]
fn keychain_delete_token() -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("Failed to access keyring: {e}"))?;
        match entry.delete_credential() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Failed to delete token from keychain: {e}")),
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Ok(())
    }
}

#[cfg(windows)]
fn get_windows_location_internal() -> Result<LocationResult, String> {
    use std::sync::{Arc, Condvar, Mutex};
    use windows::Devices::Geolocation::{Geolocator, PositionAccuracy};
    use windows::Foundation::{AsyncOperationCompletedHandler, AsyncStatus, TimeSpan};

    let geolocator = Geolocator::new()
        .map_err(|e| format!("Windows Geolocation API is unavailable: {e}"))?;

    geolocator
        .SetDesiredAccuracy(PositionAccuracy::High)
        .map_err(|e| format!("Failed to set high accuracy: {e}"))?;

    let max_age = TimeSpan {
        Duration: 600_000_000, // 60s in 100ns units
    };
    let timeout = TimeSpan {
        Duration: 25_000_000, // 2.5s in 100ns units
    };

    let op = geolocator
        .GetGeopositionAsyncWithAgeAndTimeout(max_age, timeout)
        .or_else(|_| geolocator.GetGeopositionAsync())
        .map_err(|e| format!("Location request initiation failed: {e}"))?;

    let pair = Arc::new((Mutex::new(None), Condvar::new()));
    let pair_clone = pair.clone();

    op.SetCompleted(&AsyncOperationCompletedHandler::new(
        move |_info, status| {
            let (lock, cvar) = &*pair_clone;
            let mut guard = lock.lock().unwrap();
            *guard = Some(status);
            cvar.notify_one();
            Ok(())
        },
    ))
    .map_err(|e| format!("Failed to set completion handler: {e}"))?;

    let (lock, cvar) = &*pair;
    let mut status_guard = lock.lock().unwrap();
    while status_guard.is_none() {
        let (guard, wait_res) = cvar
            .wait_timeout(status_guard, std::time::Duration::from_millis(2500))
            .map_err(|e| e.to_string())?;
        status_guard = guard;
        if wait_res.timed_out() {
            return Err("Location request timed out. Please try again.".to_string());
        }
    }

    if *status_guard != Some(AsyncStatus::Completed) {
        return Err("Location access was denied or disabled in Windows settings.".to_string());
    }

    let geoposition = op
        .GetResults()
        .map_err(|e| format!("Failed to get geoposition results: {e}"))?;

    let coord = geoposition
        .Coordinate()
        .map_err(|e| format!("Failed to get coordinate: {e}"))?;

    let point = coord
        .Point()
        .map_err(|e| format!("Failed to get point: {e}"))?;

    let pos = point
        .Position()
        .map_err(|e| format!("Failed to get position: {e}"))?;

    let accuracy = coord.Accuracy().unwrap_or(20.0);

    Ok(LocationResult {
        lat: pos.Latitude,
        lng: pos.Longitude,
        accuracy,
        source: "windows".to_string(),
    })
}

#[cfg(not(windows))]
fn get_windows_location_internal() -> Result<LocationResult, String> {
    Err("Native geolocation is only implemented on Windows; falling back to webview".to_string())
}

#[tauri::command]
async fn get_location() -> Result<LocationResult, String> {
    tauri::async_runtime::spawn_blocking(get_windows_location_internal)
        .await
        .map_err(|e| format!("Async task failed: {e}"))?
}

#[tauri::command]
fn set_tray_state(app: tauri::AppHandle, checked_in: bool) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some(tray) = app.tray_by_id("main-tray") {
        let icon_bytes: &[u8] = if checked_in {
            include_bytes!("../icons/tray-checked-in.png")
        } else {
            include_bytes!("../icons/tray-checked-out.png")
        };

        if let Ok(img) = tauri::image::Image::from_bytes(icon_bytes) {
            let _ = tray.set_icon(Some(img));
        }

        let tooltip = if checked_in {
            "Clocky: Checked In"
        } else {
            "Clocky: Checked Out"
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        let _ = checked_in;
    }
    Ok(())
}

#[tauri::command]
fn toggle_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let autolaunch = app.autolaunch();
        let is_enabled = autolaunch
            .is_enabled()
            .map_err(|e| format!("Failed to check autostart status: {e}"))?;

        if is_enabled {
            autolaunch
                .disable()
                .map_err(|e| format!("Failed to disable autostart: {e}"))?;
            Ok(false)
        } else {
            autolaunch
                .enable()
                .map_err(|e| format!("Failed to enable autostart: {e}"))?;
            Ok(true)
        }
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Ok(false)
    }
}

#[tauri::command]
fn get_autostart_status(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        app.autolaunch()
            .is_enabled()
            .map_err(|e| format!("Failed to check autostart: {e}"))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Ok(false)
    }
}

fn toggle_window_visibility(window: &WebviewWindow) {
    if let Ok(is_visible) = window.is_visible() {
        if is_visible {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

#[cfg(windows)]
#[allow(non_camel_case_types, non_snake_case)]
mod win_desktop {
    type HWND = *mut std::ffi::c_void;
    type UINT = u32;
    type WPARAM = usize;
    type LPARAM = isize;
    type LRESULT = isize;
    type UINT_PTR = usize;
    type DWORD_PTR = usize;

    const GWLP_HWNDPARENT: i32 = -8;
    const WM_SYSCOMMAND: UINT = 0x0112;
    const SC_MINIMIZE: WPARAM = 0xF020;

    type SUBCLASSPROC = unsafe extern "system" fn(
        hWnd: HWND,
        uMsg: UINT,
        wParam: WPARAM,
        lParam: LPARAM,
        uIdSubclass: UINT_PTR,
        dwRefData: DWORD_PTR,
    ) -> LRESULT;

    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> HWND;
        #[cfg(target_pointer_width = "64")]
        fn SetWindowLongPtrW(hWnd: HWND, nIndex: i32, dwNewLong: isize) -> isize;
    }

    #[link(name = "comctl32")]
    extern "system" {
        fn SetWindowSubclass(
            hWnd: HWND,
            pfnSubclass: SUBCLASSPROC,
            uIdSubclass: UINT_PTR,
            dwRefData: DWORD_PTR,
        ) -> i32;
        fn DefSubclassProc(hWnd: HWND, uMsg: UINT, wParam: WPARAM, lParam: LPARAM) -> LRESULT;
    }

    unsafe extern "system" fn widget_subclass(
        hwnd: HWND,
        msg: UINT,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: UINT_PTR,
        _data: DWORD_PTR,
    ) -> LRESULT {
        // Block minimization so widget stays visible on desktop during Win+D or 3-finger swipe
        if msg == WM_SYSCOMMAND && (wparam & 0xFFF0) == SC_MINIMIZE {
            return 0;
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn pin_to_desktop(hwnd: HWND) {
        unsafe {
            let progman_name: [u16; 8] = [
                'P' as u16, 'r' as u16, 'o' as u16, 'g' as u16,
                'm' as u16, 'a' as u16, 'n' as u16, 0,
            ];
            let progman = FindWindowW(progman_name.as_ptr(), std::ptr::null());
            if !progman.is_null() {
                SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, progman as isize);
            }
            SetWindowSubclass(hwnd, widget_subclass, 1001, 0);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--autostart"]),
            ))
            .plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                    .build(),
            );
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            let _ = window.show();

            #[cfg(windows)]
            if let Ok(hwnd) = window.hwnd() {
                win_desktop::pin_to_desktop(hwnd.0 as _);
            }

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                // Default autostart to enabled on first run
                let autolaunch = app.autolaunch();
                if let Ok(false) = autolaunch.is_enabled() {
                    let _ = autolaunch.enable();
                }

                // Create tray menu
                let show_hide_item = MenuItem::with_id(
                    app,
                    "toggle_widget",
                    "Show / Hide Clocky",
                    true,
                    None::<&str>,
                )?;
                let check_in_out_item = MenuItem::with_id(
                    app,
                    "toggle_check",
                    "Punch In / Punch Out",
                    true,
                    None::<&str>,
                )?;
                let autostart_item = MenuItem::with_id(
                    app,
                    "toggle_autostart",
                    "Toggle Start at Login",
                    true,
                    None::<&str>,
                )?;
                let logout_item =
                    MenuItem::with_id(app, "logout", "Log out", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit Clocky", true, None::<&str>)?;

                let tray_menu = Menu::with_items(
                    app,
                    &[
                        &show_hide_item,
                        &check_in_out_item,
                        &autostart_item,
                        &logout_item,
                        &quit_item,
                    ],
                )?;

                let tray_icon_bytes = include_bytes!("../icons/tray-checked-out.png");
                let initial_icon = tauri::image::Image::from_bytes(tray_icon_bytes)?;

                let _tray = TrayIconBuilder::with_id("main-tray")
                    .icon(initial_icon)
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .tooltip("Clocky - Attendance Widget")
                    .on_menu_event(move |app, event| match event.id.as_ref() {
                        "toggle_widget" => {
                            if let Some(w) = app.get_webview_window("main") {
                                toggle_window_visibility(&w);
                            }
                        }
                        "toggle_check" => {
                            let _ = app.emit("tray-check-toggle", ());
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "toggle_autostart" => {
                            let autolaunch = app.autolaunch();
                            if let Ok(is_enabled) = autolaunch.is_enabled() {
                                if is_enabled {
                                    let _ = autolaunch.disable();
                                } else {
                                    let _ = autolaunch.enable();
                                }
                            }
                        }
                        "logout" => {
                            let _ = app.emit("tray-logout", ());
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                toggle_window_visibility(&window);
                            }
                        }
                    })
                    .build(app)?;

                // Prevent closing window: hide to tray instead
                let w_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain_save_token,
            keychain_get_token,
            keychain_delete_token,
            get_location,
            set_tray_state,
            toggle_autostart,
            get_autostart_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clocky application");
}
