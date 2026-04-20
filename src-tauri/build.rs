fn main() {
    // Tauri build needs extra stack when processing many resource files (sidecar has ~16k files)
    let builder = std::thread::Builder::new().stack_size(32 * 1024 * 1024);
    let handler = builder.spawn(tauri_build::build).unwrap();
    handler.join().unwrap();
}
