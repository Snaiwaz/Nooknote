#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex},
    thread,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

const PRODUCT_NAME: &str = "隅笺 Nooknote";
const EDGE_SIZE: f64 = 10.0;
const EDGE_LENGTH: f64 = 76.0;
const DRAG_SIZE: f64 = 28.0;
const PANEL_WIDTH: f64 = 368.0;
const PANEL_HEIGHT: f64 = 548.0;
const CLOSE_GRACE_MS: u64 = 100;
static NOTE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionState {
    #[serde(default)]
    display_id: Option<Value>,
    #[serde(default = "default_edge")]
    edge: String,
    #[serde(default = "default_ratio")]
    ratio: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note { id: String, text: String, time: u64 }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiskState {
    #[serde(default)]
    draft: String,
    #[serde(default)]
    notes: Vec<Note>,
    #[serde(default = "default_position")]
    position: PositionState,
    #[serde(default)]
    open_at_login: bool,
}

impl Default for DiskState {
    fn default() -> Self {
        Self { draft: String::new(), notes: Vec::new(), position: default_position(), open_at_login: false }
    }
}

struct RuntimeState {
    data: Mutex<DiskState>,
    file: PathBuf,
    close_epoch: AtomicU64,
    quitting: AtomicBool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DragPoint {
    x: f64,
    y: f64,
    #[serde(default = "default_scale")]
    scale_factor: f64,
}

fn default_edge() -> String { "right".into() }
fn default_ratio() -> f64 { 0.5 }
fn default_scale() -> f64 { 1.0 }
fn default_position() -> PositionState {
    PositionState { display_id: None, edge: default_edge(), ratio: default_ratio() }
}
fn clamp(value: f64, low: f64, high: f64) -> f64 { value.max(low).min(high) }

fn load_state(file: &PathBuf) -> DiskState {
    fs::read_to_string(file)
        .ok()
        .and_then(|content| serde_json::from_str::<DiskState>(&content).ok())
        .map(|mut state| {
            if !matches!(state.position.edge.as_str(), "left" | "right" | "top" | "bottom") {
                state.position.edge = default_edge();
            }
            state.position.ratio = clamp(state.position.ratio, 0.12, 0.88);
            state
        })
        .unwrap_or_default()
}

fn save_state(runtime: &RuntimeState) -> Result<(), String> {
    let data = runtime.data.lock().map_err(|error| error.to_string())?;
    if let Some(parent) = runtime.file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let serialized = serde_json::to_vec_pretty(&*data).map_err(|error| error.to_string())?;
    let temp = runtime.file.with_extension("json.tmp");
    fs::write(&temp, serialized).map_err(|error| error.to_string())?;
    fs::rename(&temp, &runtime.file).map_err(|error| error.to_string())
}

fn selected_monitor(app: &AppHandle, position: &PositionState) -> Result<tauri::Monitor, String> {
    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    if let Some(id) = position.display_id.as_ref().and_then(Value::as_str) {
        if let Some(monitor) = monitors.iter().find(|monitor| monitor.name().is_some_and(|name| name == id)) {
            return Ok(monitor.clone());
        }
    }
    app.primary_monitor().map_err(|error| error.to_string())?
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| "找不到可用显示器".into())
}

fn set_window_bounds(window: &WebviewWindow, x: i32, y: i32, width: f64, height: f64, scale: f64) -> Result<(), String> {
    let scale = scale.max(1.0);
    window.set_size(Size::Physical(PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    ))).map_err(|error| error.to_string())?;
    window.set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|error| error.to_string())
}

fn trigger_bounds(monitor: &tauri::Monitor, position: &PositionState) -> (i32, i32, f64, f64) {
    let area = monitor.work_area();
    let (x, y) = (area.position.x, area.position.y);
    let (width, height) = (area.size.width as f64, area.size.height as f64);
    let (scale, ratio) = (monitor.scale_factor(), clamp(position.ratio, 0.12, 0.88));
    if position.edge == "left" || position.edge == "right" {
        let trigger_height = EDGE_LENGTH * scale;
        let trigger_width = EDGE_SIZE * scale;
        let top = clamp(y as f64 + height * ratio - trigger_height / 2.0, y as f64, y as f64 + height - trigger_height);
        let left = if position.edge == "left" { x as f64 } else { x as f64 + width - trigger_width };
        (left.round() as i32, top.round() as i32, EDGE_SIZE, EDGE_LENGTH)
    } else {
        let trigger_width = EDGE_LENGTH * scale;
        let trigger_height = EDGE_SIZE * scale;
        let left = clamp(x as f64 + width * ratio - trigger_width / 2.0, x as f64, x as f64 + width - trigger_width);
        let top = if position.edge == "top" { y as f64 } else { y as f64 + height - trigger_height };
        (left.round() as i32, top.round() as i32, EDGE_LENGTH, EDGE_SIZE)
    }
}

fn panel_bounds(monitor: &tauri::Monitor, position: &PositionState) -> (i32, i32) {
    let area = monitor.work_area();
    let (x, y) = (area.position.x, area.position.y);
    let (width, height) = (area.size.width as f64, area.size.height as f64);
    let scale = monitor.scale_factor();
    panel_bounds_in_area(x, y, width, height, scale, position)
}

fn panel_bounds_in_area(
    x: i32,
    y: i32,
    width: f64,
    height: f64,
    scale: f64,
    position: &PositionState,
) -> (i32, i32) {
    let (panel_width, panel_height) = ((PANEL_WIDTH * scale).min(width), (PANEL_HEIGHT * scale).min(height));
    // Keep the trigger window's 10 logical-pixel strip outside the panel so
    // it remains independently clickable even if the panel is foreground.
    let horizontal_gutter = (EDGE_SIZE * scale).min((width - panel_width).max(0.0));
    let vertical_gutter = (EDGE_SIZE * scale).min((height - panel_height).max(0.0));
    let ratio = clamp(position.ratio, 0.12, 0.88);
    if position.edge == "left" || position.edge == "right" {
        let top = clamp(y as f64 + height * ratio - panel_height / 2.0, y as f64, y as f64 + height - panel_height);
        let left = if position.edge == "left" { x as f64 + horizontal_gutter } else { x as f64 + width - panel_width - horizontal_gutter };
        (left.round() as i32, top.round() as i32)
    } else {
        let left = clamp(x as f64 + width * ratio - panel_width / 2.0, x as f64, x as f64 + width - panel_width);
        let top = if position.edge == "top" { y as f64 + vertical_gutter } else { y as f64 + height - panel_height - vertical_gutter };
        (left.round() as i32, top.round() as i32)
    }
}

fn apply_position(app: &AppHandle, position: &PositionState) -> Result<(), String> {
    let monitor = selected_monitor(app, position)?;
    if let Some(trigger) = app.get_webview_window("trigger") {
        let (x, y, width, height) = trigger_bounds(&monitor, position);
        set_window_bounds(&trigger, x, y, width, height, monitor.scale_factor())?;
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let (x, y) = panel_bounds(&monitor, position);
        panel.set_size(Size::Logical(tauri::LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT)))
            .map_err(|error| error.to_string())?;
        panel.set_position(Position::Physical(PhysicalPosition::new(x, y)))
            .map_err(|error| error.to_string())?;
    }
    let _ = app.emit("edge:position-changed", position);
    Ok(())
}

fn cursor_in_window(window: &WebviewWindow, cursor: PhysicalPosition<f64>) -> bool {
    if !window.is_visible().unwrap_or(false) { return false; }
    let (position, size) = match (window.outer_position(), window.outer_size()) {
        (Ok(position), Ok(size)) => (position, size),
        _ => return true,
    };
    let left = f64::from(position.x);
    let top = f64::from(position.y);
    cursor.x >= left && cursor.x < left + f64::from(size.width)
        && cursor.y >= top && cursor.y < top + f64::from(size.height)
}

fn cursor_in_interaction_area(app: &AppHandle) -> bool {
    let cursor = match app.cursor_position() {
        Ok(cursor) => cursor,
        // Keep the panel open if the system cannot confirm the pointer left it.
        Err(_) => return true,
    };
    ["panel", "trigger"].iter().any(|label| {
        app.get_webview_window(label).is_some_and(|window| cursor_in_window(&window, cursor))
    })
}

fn schedule_hide(app: AppHandle) {
    let epoch = app.state::<RuntimeState>().close_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(CLOSE_GRACE_MS));
        if app.state::<RuntimeState>().close_epoch.load(Ordering::SeqCst) == epoch {
            let app_for_ui = app.clone();
            let _ = app.run_on_main_thread(move || {
                if app_for_ui.state::<RuntimeState>().close_epoch.load(Ordering::SeqCst) != epoch
                    || cursor_in_interaction_area(&app_for_ui) {
                    return;
                }
                if let Some(panel) = app_for_ui.get_webview_window("panel") { let _ = panel.hide(); }
            });
        }
    });
}

fn cancel_hide(app: &AppHandle) {
    app.state::<RuntimeState>().close_epoch.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
fn state_get(app: AppHandle, runtime: tauri::State<'_, RuntimeState>) -> Result<DiskState, String> {
    let mut state = runtime.data.lock().map_err(|error| error.to_string())?.clone();
    let monitor = selected_monitor(&app, &state.position)?;
    if state.position.display_id.as_ref().and_then(Value::as_str) != monitor.name().map(String::as_str) {
        state.position.display_id = monitor.name().cloned().map(Value::String);
        *runtime.data.lock().map_err(|error| error.to_string())? = state.clone();
        save_state(&runtime)?;
    }
    Ok(state)
}

#[tauri::command]
fn state_position(runtime: tauri::State<'_, RuntimeState>) -> Result<PositionState, String> {
    Ok(runtime.data.lock().map_err(|error| error.to_string())?.position.clone())
}

#[tauri::command]
fn state_save_draft(draft: String, runtime: tauri::State<'_, RuntimeState>) -> Result<(), String> {
    runtime.data.lock().map_err(|error| error.to_string())?.draft = draft;
    save_state(&runtime)
}

#[tauri::command]
fn note_add(text: String, runtime: tauri::State<'_, RuntimeState>) -> Result<Option<Note>, String> {
    let text = text.trim();
    if text.is_empty() { return Ok(None); }
    let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?.as_millis() as u64;
    let sequence = NOTE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let note = Note { id: format!("{}-{:x}", time, sequence), text: text.into(), time };
    runtime.data.lock().map_err(|error| error.to_string())?.notes.insert(0, note.clone());
    save_state(&runtime)?;
    Ok(Some(note))
}

#[tauri::command]
fn note_delete(id: String, runtime: tauri::State<'_, RuntimeState>) -> Result<(), String> {
    runtime.data.lock().map_err(|error| error.to_string())?.notes.retain(|note| note.id != id);
    save_state(&runtime)
}

#[tauri::command]
fn panel_open(app: AppHandle) -> Result<(), String> {
    cancel_hide(&app);
    let position = app.state::<RuntimeState>().data.lock().map_err(|error| error.to_string())?.position.clone();
    let monitor = selected_monitor(&app, &position)?;
    let (x, y) = panel_bounds(&monitor, &position);
    if let Some(panel) = app.get_webview_window("panel") {
        panel.set_size(Size::Logical(tauri::LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT))).map_err(|error| error.to_string())?;
        panel.set_position(Position::Physical(PhysicalPosition::new(x, y))).map_err(|error| error.to_string())?;
        panel.show().map_err(|error| error.to_string())?;
        panel.set_focus().map_err(|error| error.to_string())?;
        let _ = app.emit("panel:opened", ());
    }
    Ok(())
}

#[tauri::command]
fn panel_hide(app: AppHandle) {
    cancel_hide(&app);
    if let Some(panel) = app.get_webview_window("panel") { let _ = panel.hide(); }
}

#[tauri::command]
fn panel_entered(app: AppHandle) { cancel_hide(&app); }
#[tauri::command]
fn panel_left(app: AppHandle) { schedule_hide(app); }
#[tauri::command]
fn trigger_left(app: AppHandle) { schedule_hide(app); }

#[tauri::command]
fn edge_drag_start(app: AppHandle) -> Result<(), String> {
    cancel_hide(&app);
    if let Some(panel) = app.get_webview_window("panel") { let _ = panel.hide(); }
    Ok(())
}

fn point_physical(point: DragPoint) -> PhysicalPosition<i32> {
    PhysicalPosition::new((point.x * point.scale_factor).round() as i32, (point.y * point.scale_factor).round() as i32)
}

#[tauri::command]
fn edge_drag_move(point: DragPoint, app: AppHandle) -> Result<(), String> {
    if let Some(trigger) = app.get_webview_window("trigger") {
        let scale = point.scale_factor.max(1.0);
        let physical = point_physical(point);
        set_window_bounds(&trigger, physical.x - (DRAG_SIZE * scale / 2.0) as i32,
            physical.y - (DRAG_SIZE * scale / 2.0) as i32, DRAG_SIZE, DRAG_SIZE, scale)?;
    }
    Ok(())
}

#[tauri::command]
fn edge_drag_end(point: DragPoint, app: AppHandle) -> Result<PositionState, String> {
    let point = point_physical(point);
    let monitors = app.available_monitors().map_err(|error| error.to_string())?;
    let monitor = monitors.iter().min_by_key(|monitor| {
        let area = monitor.work_area();
        let right = area.position.x + area.size.width as i32;
        let bottom = area.position.y + area.size.height as i32;
        let nearest_x = point.x.clamp(area.position.x, right);
        let nearest_y = point.y.clamp(area.position.y, bottom);
        (i64::from(point.x - nearest_x).pow(2) + i64::from(point.y - nearest_y).pow(2)) as u64
    }).cloned().ok_or_else(|| "找不到可用显示器".to_string())?;
    let area = monitor.work_area();
    let distances = [
        ("left", (point.x - area.position.x).abs()),
        ("right", (area.position.x + area.size.width as i32 - point.x).abs()),
        ("top", (point.y - area.position.y).abs()),
        ("bottom", (area.position.y + area.size.height as i32 - point.y).abs()),
    ];
    let edge = distances.iter().min_by_key(|(_, distance)| *distance).map(|(edge, _)| *edge).unwrap_or("right");
    let ratio = if edge == "left" || edge == "right" {
        (point.y - area.position.y) as f64 / area.size.height.max(1) as f64
    } else {
        (point.x - area.position.x) as f64 / area.size.width.max(1) as f64
    };
    let position = PositionState {
        display_id: monitor.name().cloned().map(Value::String),
        edge: edge.into(),
        ratio: clamp(ratio, 0.12, 0.88),
    };
    app.state::<RuntimeState>().data.lock().map_err(|error| error.to_string())?.position = position.clone();
    save_state(&app.state::<RuntimeState>())?;
    apply_position(&app, &position)?;
    Ok(position)
}

fn tray_image() -> Image<'static> {
    let mut rgba = vec![0u8; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let dx = (x as f64 + 0.5 - 16.0) / 9.5;
            let dy = (y as f64 + 0.5 - 15.5) / 11.5;
            if dx * dx + dy * dy < 1.0 && y > 4 && y < 28 {
                let index = (y * 32 + x) * 4;
                rgba[index..index + 4].copy_from_slice(&[198, 228, 181, 255]);
            }
        }
    }
    Image::new_owned(rgba, 32, 32)
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let checked = app.state::<RuntimeState>().data.lock().map(|state| state.open_at_login).unwrap_or(false);
    let startup = CheckMenuItem::with_id(app, "startup", "随系统启动", true, checked, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出隅笺", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&startup, &separator, &quit])?;
    TrayIconBuilder::with_id("nooknote-tray")
        .icon(tray_image())
        .tooltip(PRODUCT_NAME)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => {
                app.state::<RuntimeState>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            "startup" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled { manager.disable() } else { manager.enable() };
                if result.is_ok() {
                    if let Ok(mut state) = app.state::<RuntimeState>().data.lock() { state.open_at_login = !enabled; }
                    let _ = save_state(&app.state::<RuntimeState>());
                }
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn create_windows(app: &tauri::App) -> tauri::Result<()> {
    let position = app.state::<RuntimeState>().data.lock().map(|state| state.position.clone()).unwrap_or_else(|_| default_position());
    let monitor = selected_monitor(app.handle(), &position).map_err(std::io::Error::other)?;
    let (_, _, tw, th) = trigger_bounds(&monitor, &position);
    WebviewWindowBuilder::new(app, "trigger", WebviewUrl::App("trigger.html".into()))
        .title("隅笺")
        .position(0.0, 0.0)
        .inner_size(tw, th)
        .decorations(false).transparent(true).resizable(false).always_on_top(true)
        .skip_taskbar(true).focusable(false).shadow(false).visible(false).build()?;
    WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("panel.html".into()))
        .title(PRODUCT_NAME)
        .position(0.0, 0.0)
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .min_inner_size(PANEL_WIDTH, PANEL_HEIGHT).max_inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .decorations(false).transparent(true).resizable(false).always_on_top(true)
        .skip_taskbar(true).shadow(false).visible(false).build()?;
    apply_position(app.handle(), &position).map_err(std::io::Error::other)?;
    if let Some(trigger) = app.get_webview_window("trigger") { let _ = trigger.show(); }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = panel_open(app.clone());
        }))
        .plugin(tauri_plugin_autostart::Builder::new().app_name(PRODUCT_NAME).build())
        .setup(|app| {
            let mut file = app.path().app_data_dir()?;
            file.push("nooknote.json");
            let data_file = if file.exists() {
                file.clone()
            } else if let Some(app_data) = std::env::var_os("APPDATA") {
                let legacy = PathBuf::from(app_data).join("nooknote").join("nooknote.json");
                if legacy.exists() { legacy } else { file.clone() }
            } else {
                file.clone()
            };
            let state = load_state(&data_file);
            app.manage(RuntimeState {
                data: Mutex::new(state), file: file.clone(),
                close_epoch: AtomicU64::new(0), quitting: AtomicBool::new(false),
            });
            if data_file != file { save_state(&app.state::<RuntimeState>()).map_err(std::io::Error::other)?; }
            create_windows(app)?;
            create_tray(app)?;
            let open_at_login = app.state::<RuntimeState>().data.lock().map(|state| state.open_at_login).unwrap_or(false);
            let manager = app.autolaunch();
            if open_at_login && !manager.is_enabled().unwrap_or(false) { let _ = manager.enable(); }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "panel" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !window.app_handle().state::<RuntimeState>().quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            state_get, state_position, state_save_draft, note_add, note_delete,
            panel_open, panel_hide, panel_entered, panel_left, trigger_left,
            edge_drag_start, edge_drag_move, edge_drag_end
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nooknote");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_leaves_trigger_strip_reachable_on_every_edge() {
        let monitor_x = 80;
        let monitor_y = -20;
        let monitor_width = 2880.0;
        let monitor_height = 1620.0;
        let scale = 1.5;
        let gutter = (EDGE_SIZE * scale) as i32;

        for edge in ["left", "right", "top", "bottom"] {
            let position = PositionState {
                display_id: None,
                edge: edge.into(),
                ratio: 0.5,
            };
            let (panel_x, panel_y) = panel_bounds_in_area(
                monitor_x,
                monitor_y,
                monitor_width,
                monitor_height,
                scale,
                &position,
            );

            match edge {
                "left" => assert_eq!(panel_x, monitor_x + gutter),
                "right" => assert_eq!(panel_x, monitor_x + monitor_width as i32 - (PANEL_WIDTH * scale) as i32 - gutter),
                "top" => assert_eq!(panel_y, monitor_y + gutter),
                "bottom" => assert_eq!(panel_y, monitor_y + monitor_height as i32 - (PANEL_HEIGHT * scale) as i32 - gutter),
                _ => unreachable!(),
            }
        }
    }
}
