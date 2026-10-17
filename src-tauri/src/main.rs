// Oculta la consola en Windows en la versión final.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    soporty_lib::run()
}
