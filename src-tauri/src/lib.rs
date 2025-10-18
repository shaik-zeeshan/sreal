use objc2_app_kit::NSAccessibility;
use specta::specta;
use tauri::{Manager, WebviewBuilder, WindowBuilder, Wry};

use tauri_plugin_http;

use crate::mpv::{run_render_thread, PlaybackEvent};
// Credential operations are handled by the frontend JavaScript API

mod credentials;
pub mod mpv;
mod store;

#[derive(Clone)]
struct AppState {
    render_tx: std::sync::mpsc::Sender<PlaybackEvent>,
    pip_window: std::sync::Arc<std::sync::Mutex<Option<tauri::Window>>>,
}

#[specta]
#[tauri::command]
fn playback_play(app: tauri::AppHandle) {
    let app_state = app.state::<AppState>();
    if let Err(e) = app_state.render_tx.send(PlaybackEvent::Play) {
        log::error!("Failed to send play event to render thread: {}", e);
    }
}

#[specta]
#[tauri::command]
fn playback_pause(app: tauri::AppHandle) {
    let app_state = app.state::<AppState>();
    if let Err(e) = app_state.render_tx.send(PlaybackEvent::Pause) {
        log::error!("Failed to send pause event to render thread: {}", e);
    }
}

#[specta]
#[tauri::command]
fn playback_seek(app: tauri::AppHandle, time: f64) {
    let app_state = app.state::<AppState>();
    let _ = app_state.render_tx.send(PlaybackEvent::Seek(time));
}

#[specta]
#[tauri::command]
fn playback_absolute_seek(app: tauri::AppHandle, time: f64) {
    let app_state = app.state::<AppState>();
    let _ = app_state.render_tx.send(PlaybackEvent::AbsoluteSeek(time));
}

#[specta]
#[tauri::command]
fn playback_volume(app: tauri::AppHandle, volume: f64) {
    let app_state = app.state::<AppState>();
    let _ = app_state.render_tx.send(PlaybackEvent::Volume(volume));
}

#[specta]
#[tauri::command]
fn playback_speed(app: tauri::AppHandle, speed: f64) {
    let app_state = app.state::<AppState>();
    let _ = app_state.render_tx.send(PlaybackEvent::Speed(speed));
}

#[specta]
#[tauri::command]
fn playback_load(app: tauri::AppHandle, url: String) {
    let app_state = app.state::<AppState>();
    if let Err(e) = app_state.render_tx.send(PlaybackEvent::Load(url)) {
        log::error!("Failed to send load event to render thread: {}", e);
    }
}

#[specta]
#[tauri::command]
fn playback_change_subtitle(app: tauri::AppHandle, subtitle: String) {
    let app_state = app.state::<AppState>();
    let _ = app_state
        .render_tx
        .send(PlaybackEvent::ChangeSubtitle(subtitle));
}

#[specta]
#[tauri::command]
fn playback_change_audio(app: tauri::AppHandle, audio: String) {
    let app_state = app.state::<AppState>();
    let _ = app_state.render_tx.send(PlaybackEvent::ChangeAudio(audio));
}

#[specta]
#[tauri::command]
fn playback_clear(app: tauri::AppHandle) {
    let app_state = app.state::<AppState>();
    let _ = app_state.render_tx.send(PlaybackEvent::Clear);
}

#[specta]
#[tauri::command]
fn open_pip_window(app: tauri::AppHandle) -> Result<(), String> {
    let app_state = app.state::<AppState>();

    // Check if PiP window already exists
    {
        let pip_window_guard = app_state.pip_window.lock().unwrap();
        if pip_window_guard.is_some() {
            return Err("PiP window already exists".to_string());
        }
    }

    // Create PiP window
    let pip_window = tauri::WindowBuilder::new(&app, "pip")
        .title("Picture in Picture")
        .inner_size(400.0, 225.0) // 16:9 aspect ratio
        .min_inner_size(200.0, 112.0)
        .resizable(true)
        .always_on_top(true)
        .transparent(true)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| format!("Failed to create PiP window: {}", e))?;

    let _ = make_frameless_window(&pip_window)
        .map_err(|e| format!("failed to make frameless window {}", e.to_string()))?;

    // Create transparent webview for PiP
    let pip_webview =
        tauri::WebviewBuilder::new("pip", tauri::WebviewUrl::App("/pip".into())).transparent(true);

    pip_window
        .add_child(
            pip_webview,
            tauri::LogicalPosition::new(0, 0),
            pip_window.inner_size().unwrap(),
        )
        .map_err(|e| format!("Failed to add webview to PiP window: {}", e))?;

    // Store PiP window in state
    {
        let mut pip_window_guard = app_state.pip_window.lock().unwrap();
        *pip_window_guard = Some(pip_window);
    }

    // Send event to add PiP window context
    if let Err(e) = app_state.render_tx.send(PlaybackEvent::AddPipWindow) {
        log::error!("Failed to send AddPipWindow event: {}", e);
    }

    Ok(())
}

#[specta]
#[tauri::command]
fn close_pip_window(app: tauri::AppHandle) -> Result<(), String> {
    let app_state = app.state::<AppState>();

    log::info!("Closing PiP window");

    // Get and close PiP window
    let pip_window = {
        let mut pip_window_guard = app_state.pip_window.lock().unwrap();
        pip_window_guard.take()
    };

    if let Some(pip_window) = pip_window {
        pip_window
            .destroy()
            .map_err(|e| format!("Failed to close PiP window: {}", e))?;
    } else {
        return Err("No PiP window to close".to_string());
    }

    // Send event to remove PiP window context
    if let Err(e) = app_state.render_tx.send(PlaybackEvent::RemovePipWindow) {
        log::error!("Failed to send RemovePipWindow event: {}", e);
    }

    Ok(())
}

#[specta]
#[tauri::command]
fn toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let is_fullscreen = window
        .is_fullscreen()
        .map_err(|e| format!("Failed to get fullscreen state: {}", e))?;

    log::info!(
        "Current fullscreen state: {}, toggling to: {}",
        is_fullscreen,
        !is_fullscreen
    );

    // Use native Tauri fullscreen method without custom style mask manipulation
    window
        .set_fullscreen(!is_fullscreen)
        .map_err(|e| format!("Failed to set fullscreen state: {}", e))?;

    Ok(())
}

fn toggle_titlebar(window: &tauri::Window, hide: bool) -> Result<(), String> {
    // Check if window is in fullscreen mode - if so, don't modify style mask
    if let Ok(is_fullscreen) = window.is_fullscreen() {
        if is_fullscreen {
            log::info!("Window is in fullscreen mode, skipping titlebar manipulation");
            return Ok(());
        }
    }

    let ns_window = window
        .ns_window()
        .map_err(|e| format!("Failed to get NS window handle: {}", e))?;

    unsafe {
        use objc2_app_kit::NSWindowButton;

        let objc_window = ns_window as *mut objc2_app_kit::NSWindow;
        let window = objc_window.as_ref().unwrap();

        let close_button = window
            .standardWindowButton(NSWindowButton::CloseButton)
            .unwrap();
        let min_button = window
            .standardWindowButton(NSWindowButton::MiniaturizeButton)
            .unwrap();
        let zoom_button = window
            .standardWindowButton(NSWindowButton::ZoomButton)
            .unwrap();

        // Hide the close button
        close_button.setHidden(hide);

        // Hide the minimize button
        min_button.setHidden(hide);

        // Hide the zoom button
        zoom_button.setHidden(hide);
    }

    Ok(())
}

fn make_frameless_window(window: &tauri::Window) -> Result<(), String> {
    // let _ = toggle_titlebar(window, true).map_err(|e| format!("failed to hide titlebar"))?;

    let ns_window = window
        .ns_window()
        .map_err(|e| format!("Failed to get NS window handle: {}", e))?;

    unsafe {
        use objc2_app_kit::{NSWindowButton, NSWindowCollectionBehavior, NSWindowTitleVisibility};

        let objc_window = ns_window as *mut objc2_app_kit::NSWindow;
        let window = objc_window.as_ref().unwrap();

        let close_button = window
            .standardWindowButton(NSWindowButton::CloseButton)
            .unwrap();
        let min_button = window
            .standardWindowButton(NSWindowButton::MiniaturizeButton)
            .unwrap();
        let zoom_button = window
            .standardWindowButton(NSWindowButton::ZoomButton)
            .unwrap();

        close_button.setHidden(true);
        min_button.setHidden(true);
        zoom_button.setHidden(true);

        window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
        window.setTitlebarAppearsTransparent(true);

        window.setLevel(26);

        window.setMovableByWindowBackground(true);

        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary,
        );
    };

    Ok(())
}

#[specta]
#[tauri::command]
fn toggle_titlebar_hide(app: tauri::AppHandle, hide: bool) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    toggle_titlebar(&window, hide)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    let tauri_context = tauri::generate_context!();

    tauri::async_runtime::set(tokio::runtime::Handle::current());

    let specta_builder = tauri_specta::Builder::<Wry>::new()
        .commands(tauri_specta::collect_commands![
            playback_play,
            playback_pause,
            playback_seek,
            playback_absolute_seek,
            playback_volume,
            playback_speed,
            playback_load,
            playback_change_subtitle,
            playback_change_audio,
            playback_clear,
            toggle_titlebar_hide,
            toggle_fullscreen,
            open_pip_window,
            close_pip_window
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .typ::<store::GeneralSettings>();

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/lib/tauri.ts",
        )
        .expect("Failed to export typescript bindings");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            };

            // Initialize Stronghold plugin for frontend use
            let app_data_dir = app
                .path()
                .app_local_data_dir()
                .expect("could not resolve app local data path");

            // Ensure the directory exists
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|e| format!("Failed to create app data directory: {}", e))?;

            let salt_path = app_data_dir.join("salt.txt");

            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())?;

            let handle = app.handle().clone();

            let window = WindowBuilder::new(&handle, "main")
                .hidden_title(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .build()
                .unwrap();

            // webview should be transparent if window url start with /video
            let webview =
                WebviewBuilder::new("main", tauri::WebviewUrl::App("/".into())).transparent(true);

            window
                .add_child(
                    webview,
                    tauri::LogicalPosition::new(0, 0),
                    window.inner_size().unwrap(),
                )
                .unwrap();

            // Create channel for render signals
            let (render_tx, render_rx) = std::sync::mpsc::channel::<PlaybackEvent>();

            let app_state = AppState {
                render_tx: render_tx.clone(),
                pip_window: std::sync::Arc::new(std::sync::Mutex::new(None)),
            };

            // Move all MPV and OpenGL setup to a dedicated thread
            let window_clone = window.clone();
            let app_state_clone = app_state.clone();
            let get_pip_window =
                Box::new(move || app_state_clone.pip_window.lock().unwrap().clone());
            tokio::spawn(run_render_thread(
                window_clone,
                render_tx,
                render_rx,
                get_pip_window,
            ));

            app.manage(app_state);

            Ok(())
        })
        .on_window_event(|_window, event| {
            match event {
                _ => {}
            };
        })
        .build(tauri_context)
        .expect("error while running tauri application");

    app.run(|_app, event| {
        let app_state = _app.state::<AppState>();
        match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                println!("ExitRequested: {:?}", code);
            }
            tauri::RunEvent::WindowEvent { label, event, .. } => {
                match event {
                    tauri::WindowEvent::Resized(physical_size) => {
                        let (width, height): (u32, u32) = physical_size.into();

                        // Only send resize events for the main window to avoid affecting PiP rendering
                        if label == "main" {
                            if let Err(e) = app_state
                                .render_tx
                                .send(PlaybackEvent::Resize(width, height))
                            {
                                log::error!("Failed to send resize event to render thread: {}", e);
                            }

                            if let Some(webview) = _app.get_webview("main") {
                                if let Err(e) = webview.set_size(physical_size) {
                                    log::error!("Failed to resize webview: {}", e);
                                }

                                let _ = webview.set_focus();
                            } else {
                                log::warn!("Main webview not found during resize");
                            }
                        } else if label == "pip" {
                            // Handle PiP window resize separately
                            if let Some(webview) = _app.get_webview("pip") {
                                if let Err(e) = webview.set_size(physical_size) {
                                    log::error!("Failed to resize PiP webview: {}", e);
                                }
                            }

                            // Send PiP resize event to render thread
                            if let Err(e) = app_state
                                .render_tx
                                .send(PlaybackEvent::ResizePipWindow { width, height })
                            {
                                log::error!(
                                    "Failed to send PiP resize event to render thread: {}",
                                    e
                                );
                            }
                        }
                    }
                    _ => {}
                };
            }
            _ => {}
        };
    });
}
