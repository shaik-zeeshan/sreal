use std::{
    collections::HashMap,
    sync::mpsc::{Receiver, Sender},
    time::Duration,
};

use gl::types::GLsizei;
use glutin::{
    config::{ConfigTemplateBuilder, GlConfig},
    context::{ContextApi, ContextAttributesBuilder, PossiblyCurrentContext, Version},
    display::{Display, GetGlDisplay},
    prelude::{GlDisplay, NotCurrentGlContext, PossiblyCurrentGlContext},
    surface::{GlSurface, Surface, SurfaceAttributesBuilder, WindowSurface},
};
use libmpv2::{
    events::PropertyData,
    render::{OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType},
    Mpv,
};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, PhysicalSize, Window};

/// OpenGL context management struct
pub struct OpenGLContext {
    pub display: Display,
    pub surface: Surface<WindowSurface>,
    pub context: PossiblyCurrentContext,
}

impl OpenGLContext {
    pub fn new(window: &Window) -> Result<Self, Box<dyn std::error::Error>> {
        let (display, surface, context) = create_gl_context(window.clone())?;
        Ok(OpenGLContext {
            display,
            surface,
            context,
        })
    }

    pub fn resize(&self, width: u32, height: u32) -> Result<(), Box<dyn std::error::Error>> {
        self.surface.resize(
            &self.context,
            std::num::NonZeroU32::new(width).unwrap_or(std::num::NonZeroU32::new(1).unwrap()),
            std::num::NonZeroU32::new(height).unwrap_or(std::num::NonZeroU32::new(1).unwrap()),
        );
        Ok(())
    }

    pub fn clear_to_transparent(&self, window: &Window) {
        let (width, height): (u32, u32) = window
            .inner_size()
            .unwrap_or(PhysicalSize::new(1920, 1080))
            .into();

        unsafe {
            // Load OpenGL functions
            gl::load_with(|s| {
                let c_str = std::ffi::CString::new(s).unwrap();
                self.context.display().get_proc_address(&c_str) as *const _
            });

            // Set viewport
            gl::Viewport(0, 0, width as GLsizei, height as GLsizei);

            // Enable blending for transparency
            gl::Enable(gl::BLEND);
            gl::BlendFunc(gl::SRC_ALPHA, gl::ONE_MINUS_SRC_ALPHA);

            // Clear to transparent (RGBA: 0, 0, 0, 0)
            gl::ClearColor(0.0, 0.0, 0.0, 0.0);
            gl::Clear(gl::COLOR_BUFFER_BIT);

            // Swap buffers to display the transparent screen
            if let Err(e) = self.surface.swap_buffers(&self.context) {
                eprintln!("Failed to swap buffers after clearing: {}", e);
            }
        }
    }
}

/// MPV player management struct
pub struct MpvPlayer {
    pub mpv: Mpv,
    pub render_context: RenderContext,
    pub window: Window,
}


impl MpvPlayer {
    pub fn new(display: &Display, window: &Window) -> Result<Self, Box<dyn std::error::Error>> {
        let mut mpv = Mpv::new()?;

        // Configure MPV properties
        mpv.set_property("vo", "libmpv")?;
        mpv.set_property("idle", "yes")?;
        mpv.set_property("pause", true)?;
        mpv.set_property("keep-open", "yes")?;
        mpv.set_property("input-ipc-server", "/tmp/sreal")?;

        // Observe properties
        mpv.observe_property("pause", libmpv2::Format::Flag, 1)?;
        mpv.observe_property("time-pos", libmpv2::Format::String, 2)?;
        mpv.observe_property("track-list", libmpv2::Format::String, 3)?;
        mpv.observe_property("duration", libmpv2::Format::String, 4)?;
        mpv.observe_property("aid", libmpv2::Format::String, 5)?;
        mpv.observe_property("sid", libmpv2::Format::String, 6)?;
        mpv.observe_property("speed", libmpv2::Format::Double, 7)?;
        // Cache and buffering properties
        mpv.observe_property("demuxer-cache-time", libmpv2::Format::Double, 8)?;
        mpv.observe_property("cache-buffering-state", libmpv2::Format::Int64, 9)?;
        mpv.observe_property("paused-for-cache", libmpv2::Format::Flag, 10)?;

        mpv.disable_deprecated_events()?;

        // Create render context
        let render_context = RenderContext::new(
            unsafe { mpv.ctx.as_mut() },
            vec![
                RenderParam::ApiType(RenderParamApiType::OpenGl),
                RenderParam::InitParams(OpenGLInitParams {
                    get_proc_address: get_proc_address_fn,
                    ctx: display as *const _ as *mut std::ffi::c_void,
                }),
            ],
        )?;

        Ok(MpvPlayer {
            mpv,
            render_context,
            window: window.clone(),
        })
    }

    pub fn handle_playback_event(&self, event: PlaybackEvent) {
        let loaded_file = !self.mpv.get_property::<bool>("idle-active").unwrap();
        match event {
            PlaybackEvent::Play => {
                self.mpv.set_property("pause", false).unwrap();
            }
            PlaybackEvent::Pause => {
                self.mpv.set_property("pause", true).unwrap();
            }
            PlaybackEvent::Seek(time) => {
                if loaded_file {
                    self.mpv
                        .command("seek", &[&time.to_string(), "relative"])
                        .unwrap();
                }
            }
            PlaybackEvent::AbsoluteSeek(time) => {
                self.mpv.command("seek", &[&time.to_string(), "absolute"]).unwrap();
            }
            PlaybackEvent::Volume(volume) => {
                self.mpv.set_property("volume", volume).unwrap();
            }
            PlaybackEvent::Speed(speed) => {
                self.mpv.set_property("speed", speed).unwrap();
            }
            PlaybackEvent::EndOfFile => {
                // self.mpv.set_property("pause", true).unwrap();
            }
            PlaybackEvent::Error(error) => {
                eprintln!("Error: {}", error);
            }
            PlaybackEvent::ChangeSubtitle(subtitle) => {
                self.mpv.set_property("sid", subtitle).unwrap();
            }
            PlaybackEvent::ChangeAudio(audio) => {
                self.mpv.set_property("aid", audio).unwrap();
            }
            PlaybackEvent::Load(url) => {
                self.mpv.command("loadfile", &[&url, "replace"]).unwrap();
                self.mpv.set_property("pause", false).unwrap();
            }
            PlaybackEvent::FileLoaded => {
                // self.mpv.set_property("time-pos", "0").unwrap();
                let time = self.mpv.get_property::<f64>("time-pos").unwrap();
                let duration = self.mpv.get_property::<f64>("duration").unwrap();
                self.window.emit("file-loaded", (time, duration)).unwrap();
            }
            _ => {}
        }
    }
}

/// Render manager struct
pub struct RenderManager {
    gl_contexts: HashMap<String, OpenGLContext>,
    mpv_player: MpvPlayer,
    active_window: String,
}

impl RenderManager {
    pub fn new(window: &Window) -> Result<Self, Box<dyn std::error::Error>> {
        let gl_context = OpenGLContext::new(window)?;
        let mpv_player = MpvPlayer::new(&gl_context.display, window)?;

        let mut gl_contexts = HashMap::new();
        gl_contexts.insert("main".to_string(), gl_context);

        Ok(RenderManager {
            gl_contexts,
            mpv_player,
            active_window: "main".to_string(),
        })
    }

    pub fn add_pip_window_context(&mut self, window: &Window) -> Result<(), Box<dyn std::error::Error>> {
        // Use the same display as the main context to enable resource sharing
        let main_context = self.gl_contexts.get("main").unwrap();
        let gl_context = create_gl_context_with_display(window, &main_context.display, &main_context.context)?;
        self.gl_contexts.insert("pip".to_string(), gl_context);
        self.active_window = "pip".to_string();
        Ok(())
    }

    pub fn remove_pip_window_context(&mut self) {
        self.gl_contexts.remove("pip");
        self.active_window = "main".to_string();
        let main_context = self.gl_contexts.get("main").unwrap();
        main_context.context.make_current(&main_context.surface).unwrap();
    }

    pub fn render(&self, window: &Window) {
        self.render_to_window(&self.active_window, window);
    }

    pub fn render_to_window(&self, window_id: &str, window: &Window) {
        let gl_context = match self.gl_contexts.get(window_id) {
            Some(ctx) => ctx,
            None => {
                log::error!("Window context '{}' not found, skipping render", window_id);
                return;
            }
        };

        let (width, height): (u32, u32) = window
            .inner_size()
            .unwrap_or(PhysicalSize::new(1920, 1080))
            .into();

        // Try to render with timeout
        match self
            .mpv_player
            .render_context
            .render::<()>(0, width as _, height as _, true)
        {
            Ok(_) => {
                // Only swap buffers if render succeeded
                if let Err(e) = gl_context
                    .surface
                    .swap_buffers(&gl_context.context)
                {
                    log::error!("Failed to swap buffers for window '{}': {}", window_id, e);
                }
            }
            Err(e) => {
                log::error!("Failed to render to window '{}': {}", window_id, e);
                return;
            }
        }
    }

    pub fn clear(&self, window: &Window) {
        self.mpv_player.mpv.set_property("pause", true).unwrap();
        if let Some(gl_context) = self.gl_contexts.get(&self.active_window) {
            gl_context.clear_to_transparent(window);
        }
    }

    pub fn resize(&self, window_id: &str, width: u32, height: u32) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(gl_context) = self.gl_contexts.get(window_id) {
            gl_context.resize(width, height)
        } else {
            Err(format!("Window context '{}' not found", window_id).into())
        }
    }


    pub fn set_update_callback<F>(&mut self, callback: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.mpv_player.render_context.set_update_callback(callback);
    }

    pub fn wait_event(
        &mut self,
        timeout: f64,
    ) -> Option<Result<libmpv2::events::Event, libmpv2::Error>> {
        self.mpv_player.mpv.wait_event(timeout)
    }
}

/// Event handler struct
pub struct EventHandler;

impl EventHandler {
    pub fn handle_mpv_events(
        event: libmpv2::events::Event,
        window: &Window,
        render_tx: Sender<PlaybackEvent>,
    ) {
        match event {
            libmpv2::events::Event::FileLoaded => {
                //    render_tx.send(PlaybackEvent::FileLoaded).unwrap();
                //window.emit("file-loaded", ()).unwrap();
                render_tx.send(PlaybackEvent::FileLoaded).unwrap();
            }

            libmpv2::events::Event::PropertyChange {
                name: "pause",
                change: PropertyData::Flag(pause),
                reply_userdata: 1,
            } => {
                window.emit("pause", pause).unwrap();
            }
            libmpv2::events::Event::PropertyChange {
                name: "time-pos",
                change: PropertyData::Str(time),
                reply_userdata: 2,
            } => {
                window.emit("playback-time", time).unwrap();
            }
            libmpv2::events::Event::PropertyChange {
                name: "duration",
                change: PropertyData::Str(duration),
                reply_userdata: 4,
            } => {
                let dur =
                    Duration::from_secs_f64(duration.parse().expect("duration failed to f64"));
                window.emit("duration", dur.as_secs_f64()).unwrap();
            }
            libmpv2::events::Event::PropertyChange {
                name: "track-list",
                change: PropertyData::Str(data),
                reply_userdata: 3,
            } => {
                let mut audio_tracks = Vec::new();
                let mut subtitle_tracks = Vec::new();

                match serde_json::from_str::<Vec<Track>>(data) {
                    Ok(track_list) => {
                        track_list.iter().for_each(|track| {
                            if track.media_type == "video" {
                                return;
                            };

                            if track.media_type == "audio" {
                                audio_tracks.push(track);
                            } else if track.media_type == "sub" {
                                subtitle_tracks.push(track);
                            }
                        });
                        window.emit("audio-list", audio_tracks.clone()).unwrap();
                        window
                            .emit("subtitle-list", subtitle_tracks.clone())
                            .unwrap();
                    }

                    Err(err) => {
                        println!(
                            "Error occured when serializing (track-list): {}",
                            err.to_string()
                        )
                    }
                };
            }
            libmpv2::events::Event::PropertyChange {
                name: "aid",
                change: PropertyData::Str(aid),
                reply_userdata: 5,
            } => {
                println!("aid: {}", aid);
                window.emit("aid", aid).unwrap();
            }

            libmpv2::events::Event::PropertyChange {
                name: "sid",
                change: PropertyData::Str(sid),
                reply_userdata: 6,
            } => {
                println!("sid: {}", sid);
                window.emit("sid", sid).unwrap();
            }

            libmpv2::events::Event::PropertyChange {
                name: "speed",
                change: PropertyData::Double(speed),
                reply_userdata: 7,
            } => {
                window.emit("speed", speed).unwrap();
            }

            // Cache and buffering events
            libmpv2::events::Event::PropertyChange {
                name: "demuxer-cache-time",
                change: PropertyData::Double(cache_time),
                reply_userdata: 8,
            } => {
                window.emit("cache-time", cache_time).unwrap();
            }

            libmpv2::events::Event::PropertyChange {
                name: "cache-buffering-state",
                change: PropertyData::Int64(buffering_state),
                reply_userdata: 9,
            } => {
                window.emit("buffering-state", buffering_state).unwrap();
            }

            libmpv2::events::Event::PropertyChange {
                name: "paused-for-cache",
                change: PropertyData::Flag(paused_for_cache),
                reply_userdata: 10,
            } => {
                window.emit("paused-for-cache", paused_for_cache).unwrap();
            }

            libmpv2::events::Event::EndFile(reason) => {
                log::info!("MPV: End of file: {:?}", reason);
                render_tx.send(PlaybackEvent::EndOfFile).unwrap();
                // Also emit to frontend for autoplay handling with reason code
                window.emit("end-of-file", reason).unwrap();
            }
            _ => {}
        }
    }
}

fn get_proc_address_fn(ctx: &*mut std::ffi::c_void, name: &str) -> *mut std::ffi::c_void {
    use std::ffi::CString;

    // Cast the context back to a display pointer
    let display_ptr = *ctx as *const glutin::display::Display;

    if let Ok(c_name) = CString::new(name) {
        unsafe { (*display_ptr).get_proc_address(&c_name).cast_mut() }
    } else {
        std::ptr::null_mut()
    }
}


fn create_gl_context_with_display(
    window: &Window,
    shared_display: &Display,
    context_sharing: &PossiblyCurrentContext,
) -> Result<OpenGLContext, Box<dyn std::error::Error>> {
    let raw_handle = window.window_handle().unwrap().as_raw();

    // Use the same display as the main context
    let gl_display = shared_display;

    let configs = unsafe {
        gl_display
            .find_configs(
                ConfigTemplateBuilder::new()
                    .with_alpha_size(8)
                    .with_transparency(true)
                    .build(),
            )
            .unwrap()
    };

    let gl_config = configs
        .reduce(|accum, config| {
            let transparency_check = config.supports_transparency().unwrap_or(false)
                & !accum.supports_transparency().unwrap_or(false);

            if transparency_check || config.num_samples() < accum.num_samples() {
                config
            } else {
                accum
            }
        })
        .unwrap();

    let context_attributes = ContextAttributesBuilder::new()
        .with_context_api(ContextApi::OpenGl(Some(Version::new(3, 3))))
        .with_sharing(context_sharing)
        .build(Some(raw_handle));

    let not_current_gl_context =
        unsafe { gl_display.create_context(&gl_config, &context_attributes)? };

    let (width, height): (u32, u32) = window.inner_size().unwrap().into();

    let surface_attributes = SurfaceAttributesBuilder::<WindowSurface>::new().build(
        raw_handle,
        std::num::NonZeroU32::new(width).unwrap_or(std::num::NonZeroU32::new(1).unwrap()),
        std::num::NonZeroU32::new(height).unwrap_or(std::num::NonZeroU32::new(1).unwrap()),
    );

    let surface = unsafe {
        gl_config
            .display()
            .create_window_surface(&gl_config, &surface_attributes)?
    };

    let gl_context = not_current_gl_context.make_current(&surface)?;

    Ok(OpenGLContext {
        display: gl_display.clone(),
        surface,
        context: gl_context,
    })
}

fn create_gl_context(
    window: Window,
) -> Result<(Display, Surface<WindowSurface>, PossiblyCurrentContext), Box<dyn std::error::Error>> {
    let raw_display_handle = window
        .display_handle()
        .expect("Failed to get display handle")
        .as_raw();

    // Create glutin display
    let gl_display = unsafe {
        glutin::display::Display::new(
            raw_display_handle,
            glutin::display::DisplayApiPreference::Cgl, // or other preferences
        )
        .map_err(|e| format!("Failed to create GL display: {}", e))?
    };

    let raw_handle = window.window_handle().unwrap().as_raw();

    let configs = unsafe {
        gl_display
            .find_configs(
                ConfigTemplateBuilder::new()
                    .with_alpha_size(8)
                    .with_transparency(true)
                    .build(),
            )
            .unwrap()
    };

    let gl_config = configs
        .reduce(|accum, config| {
            let transparency_check = config.supports_transparency().unwrap_or(false)
                & !accum.supports_transparency().unwrap_or(false);

            if transparency_check || config.num_samples() < accum.num_samples() {
                config
            } else {
                accum
            }
        })
        .unwrap();

    let context_attributes = ContextAttributesBuilder::new()
        .with_context_api(ContextApi::OpenGl(Some(Version::new(3, 3))))
        .build(Some(raw_handle));

    let not_current_gl_context =
        unsafe { gl_display.create_context(&gl_config, &context_attributes)? };

    let (width, height): (u32, u32) = window.inner_size().unwrap().into();

    let surface_attributes = SurfaceAttributesBuilder::<WindowSurface>::new().build(
        raw_handle,
        std::num::NonZeroU32::new(width).unwrap_or(std::num::NonZeroU32::new(1).unwrap()),
        std::num::NonZeroU32::new(height).unwrap_or(std::num::NonZeroU32::new(1).unwrap()),
    );

    let surface = unsafe {
        gl_config
            .display()
            .create_window_surface(&gl_config, &surface_attributes)?
    };

    let gl_context = not_current_gl_context.make_current(&surface)?;

    Ok((gl_display, surface, gl_context))
}

#[derive(Debug, Serialize, Deserialize)]
pub enum PlaybackEvent {
    Play,
    Pause,
    Seek(f64),
    AbsoluteSeek(f64),
    Volume(f64),
    Speed(f64),
    EndOfFile,
    Error(String),
    ChangeSubtitle(String),
    ChangeAudio(String),
    Resize(u32, u32),
    Load(String),
    Clear,
    Redraw,
    FileLoaded,
    AddPipWindow,
    RemovePipWindow,
    ResizePipWindow { width: u32, height: u32 },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MpvEvent {
    event: PlaybackEvent,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Track {
    id: i64,
    #[serde(rename = "type")]
    media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lang: Option<String>,
}

pub async fn run_render_thread(
    window: Window,
    render_tx: Sender<PlaybackEvent>,
    render_rx: Receiver<PlaybackEvent>,
    get_pip_window: Box<dyn Fn() -> Option<Window> + Send + Sync>,
) {
    // Create render manager with OpenGL context and MPV player
    let mut render_manager = RenderManager::new(&window).unwrap();
    log::info!("OpenGL context and MPV player created successfully on render thread");

    // Set up MPV update callback to trigger rendering on this thread
    render_manager.set_update_callback({
        let render_tx = render_tx.clone();
        move || {
            let _ = render_tx.send(PlaybackEvent::Redraw);
        }
    });

    // Combined event loop - handle both MPV events and render signals
    loop {
        // Check for MPV events
        if let Some(event) = render_manager.wait_event(0.0) {
            if let Ok(event) = event {
                EventHandler::handle_mpv_events(event, &window, render_tx.clone());
            };
        }

        // Check for render signals (non-blocking)
        if let Ok(event) = render_rx.recv() {
            match event {
                PlaybackEvent::Redraw => {
                    // Render to the active window
                    if render_manager.active_window == "pip" {
                        if let Some(pip_window) = get_pip_window() {
                            render_manager.render_to_window("pip", &pip_window);
                        } else {
                            // PiP window no longer exists, switch back to main and render there
                            log::info!("PiP window no longer exists, switching back to main window");
                            render_manager.render_to_window("main", &window);
                        }
                    } else {
                        render_manager.render_to_window("main", &window);
                    }
                }
                PlaybackEvent::Resize(width, height) => {
                    if let Err(e) = render_manager.resize(&render_manager.active_window, width, height) {
                        log::error!("Failed to resize: {}", e);
                    }
                }
                PlaybackEvent::Clear => {
                    render_manager.clear(&window);
                }
                PlaybackEvent::AddPipWindow => {
                    // Get the PiP window and add its GL context
                    if let Some(pip_window) = get_pip_window() {
                        if let Err(e) = render_manager.add_pip_window_context(&pip_window) {
                            log::error!("Failed to add PiP window context: {}", e);
                        } else {
                            log::info!("PiP window context added successfully");
                        }
                    } else {
                        log::error!("AddPipWindow event received but no PiP window found");
                    }
                }
                PlaybackEvent::RemovePipWindow => {
                    // Remove the PiP window context
                    render_manager.remove_pip_window_context();
                    log::info!("PiP window context removed");
                    
                    log::info!("Active window: {}", render_manager.active_window);
                }
                PlaybackEvent::ResizePipWindow { width, height } => {
                    if let Err(e) = render_manager.resize("pip", width, height) {
                        log::error!("Failed to resize PiP window: {}", e);
                    }
                }
                _ => render_manager.mpv_player.handle_playback_event(event),
            }
        }

        //std::thread::sleep(std::time::Duration::from_millis(fps.into())); // ~40 FPS
    }
}
