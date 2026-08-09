mod auth;
mod backup;
mod edge_bridge;
mod lifecycle;
mod pintia;
mod zju;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};

const DESKTOP_EXIT_REQUEST_EVENT: &str = "fuck-ddl:desktop-exit-request";

#[tauri::command]
fn complete_desktop_exit(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(edge_bridge::EdgeBridgeState::default())
        .manage(auth::DesktopOAuthCallbackState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            let Some(instance_guard) = lifecycle::acquire_single_instance(app.handle().clone())?
            else {
                std::process::exit(0);
            };
            app.manage(instance_guard);

            let show = MenuItem::with_id(app, "show", "显示 Fuck DDL", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "彻底退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .tooltip("Fuck DDL")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        let _ = app.emit(DESKTOP_EXIT_REQUEST_EVENT, ());
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            let tray = tray_builder.build(app)?;
            std::mem::forget(tray);

            let state = app.state::<edge_bridge::EdgeBridgeState>().inner().clone();
            edge_bridge::start(app.handle().clone(), state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            backup::save_local_backup,
            auth::start_desktop_oauth_callback,
            auth::open_external_url,
            edge_bridge::set_edge_focus_active,
            pintia::open_pintia_login,
            pintia::reset_pintia_session,
            pintia::sync_pintia,
            zju::open_zju_login,
            zju::sync_zju,
            complete_desktop_exit
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Fuck DDL desktop application");
}
