use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // In desktop mode, start the server backend as a sidecar process
            #[cfg(not(debug_assertions))]
            {
                let sidecar_command = app
                    .shell()
                    .sidecar("node")
                    .map_err(|e| e.to_string())?
                    .args(["../packages/server/dist/index.js"]);
                let (_rx, _child) = sidecar_command.spawn().map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}