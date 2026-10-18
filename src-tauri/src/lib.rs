//! Soporty para Windows — parte nativa.
//!
//! El video, la voz, la señalización y el chat los maneja la interfaz web dentro
//! del WebView (reusa el mismo motor que la página de Soporty). Rust solo hace lo
//! que el navegador no puede: mover el mouse y teclear en el sistema (control
//! remoto) y mostrar un aviso visible mientras el técnico controla.
//!
//! El control SIEMPRE lo autoriza el cliente. Mientras está activo se muestra una
//! barra «Un técnico está controlando tu equipo — Detener» siempre encima, y el
//! cliente puede cortarlo al instante. Si CONTROLLING es false, rc_apply ignora
//! todo, así que ninguna orden llega al sistema sin permiso vigente.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};

use enigo::{
    Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// ¿Hay una sesión de control autorizada y vigente?
static CONTROLLING: AtomicBool = AtomicBool::new(false);

// El motor de entrada (enigo) vive en el hilo principal: en macOS no es Send,
// así que no puede guardarse en un State compartido. Se crea una sola vez y se
// reutiliza; la inyección siempre corre en el hilo principal (lo exige macOS).
thread_local! {
    static ENIGO: RefCell<Option<Enigo>> = RefCell::new(None);
}

/// Un evento de control que manda el técnico (ya convertido a píxeles físicos).
#[derive(Deserialize)]
struct Ev {
    t: String,
    #[serde(default)]
    x: i32,
    #[serde(default)]
    y: i32,
    #[serde(default)]
    b: String,
    #[serde(default)]
    amount: i32,
    #[serde(default)]
    k: String,
    #[serde(default)]
    text: String,
}

/// Tamaño físico de la pantalla principal (para mapear coordenadas con DPI correcto).
#[tauri::command]
fn rc_screen(app: AppHandle) -> (u32, u32) {
    if let Ok(Some(mon)) = app.primary_monitor() {
        let s = mon.size();
        return (s.width, s.height);
    }
    (1920, 1080)
}

/// El cliente autorizó el control: se marca activo y se muestra la barra de aviso.
#[tauri::command]
fn rc_start(app: AppHandle) {
    CONTROLLING.store(true, Ordering::SeqCst);
    if app.get_webview_window("overlay").is_none() {
        let _ = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
            .title("Soporty")
            .inner_size(380.0, 54.0)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(true)
            .build();
    }
}

/// Termina el control: ya nada se aplica, se cierra la barra y se avisa a la interfaz.
#[tauri::command]
fn rc_stop(app: AppHandle) {
    CONTROLLING.store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.close();
    }
    let _ = app.emit("rc-stopped", ());
}

/// Aplica una tanda de eventos de control, solo si hay autorización vigente.
/// Se ejecuta en el hilo principal (requerido por macOS) con un enigo reutilizado.
#[tauri::command]
fn rc_apply(app: AppHandle, events: Vec<Ev>) {
    if !CONTROLLING.load(Ordering::SeqCst) {
        return;
    }
    let _ = app.run_on_main_thread(move || apply_events(events));
}

fn apply_events(events: Vec<Ev>) {
    ENIGO.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Enigo::new(&Settings::default()).ok();
        }
        let enigo = match slot.as_mut() {
            Some(e) => e,
            None => return,
        };
        apply_with(enigo, events);
    });
}

fn apply_with(enigo: &mut Enigo, events: Vec<Ev>) {
    for ev in events {
        match ev.t.as_str() {
            "move" => {
                let _ = enigo.move_mouse(ev.x, ev.y, Coordinate::Abs);
            }
            "down" | "up" | "click" => {
                let btn = match ev.b.as_str() {
                    "right" => Button::Right,
                    "middle" => Button::Middle,
                    _ => Button::Left,
                };
                let dir = match ev.t.as_str() {
                    "down" => Direction::Press,
                    "up" => Direction::Release,
                    _ => Direction::Click,
                };
                let _ = enigo.button(btn, dir);
            }
            "wheel" => {
                if ev.amount != 0 {
                    let _ = enigo.scroll(ev.amount, Axis::Vertical);
                }
            }
            "text" => {
                if !ev.text.is_empty() {
                    let _ = enigo.text(&ev.text);
                }
            }
            "key" => {
                let dir = Direction::Click;
                if let Some(key) = map_key(&ev.k) {
                    let _ = enigo.key(key, dir);
                }
            }
            "keydown" | "keyup" => {
                let dir = if ev.t == "keydown" {
                    Direction::Press
                } else {
                    Direction::Release
                };
                if let Some(key) = map_key(&ev.k) {
                    let _ = enigo.key(key, dir);
                }
            }
            _ => {}
        }
    }
}

/// Traduce el nombre de tecla del navegador (KeyboardEvent.key) a una tecla de enigo.
fn map_key(name: &str) -> Option<Key> {
    let k = match name {
        "Enter" => Key::Return,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Escape" | "Esc" => Key::Escape,
        "Delete" | "Del" => Key::Delete,
        " " | "Spacebar" | "Space" => Key::Space,
        "ArrowUp" | "Up" => Key::UpArrow,
        "ArrowDown" | "Down" => Key::DownArrow,
        "ArrowLeft" | "Left" => Key::LeftArrow,
        "ArrowRight" | "Right" => Key::RightArrow,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "Control" => Key::Control,
        "Alt" => Key::Alt,
        "Shift" => Key::Shift,
        "Meta" | "OS" | "Win" => Key::Meta,
        "CapsLock" => Key::CapsLock,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        other => {
            // Una sola letra/símbolo en un atajo (Ctrl+C, etc.): se manda como carácter.
            let mut chars = other.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                return Some(Key::Unicode(c.to_ascii_lowercase()));
            }
            return None;
        }
    };
    Some(k)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            rc_screen, rc_start, rc_stop, rc_apply
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Soporty");
}
