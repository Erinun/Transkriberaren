use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Polls for Microsoft Teams meeting windows and sends a notification when one is detected.
pub struct MeetingDetector {
    monitoring: Arc<AtomicBool>,
    seen_sessions: Arc<Mutex<HashSet<String>>>,
}

impl MeetingDetector {
    pub fn new() -> Self {
        Self {
            monitoring: Arc::new(AtomicBool::new(false)),
            seen_sessions: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn start_monitoring(&self, app: AppHandle) {
        if self.monitoring.load(Ordering::SeqCst) {
            return;
        }
        self.monitoring.store(true, Ordering::SeqCst);
        self.seen_sessions.lock().unwrap().clear();

        let monitoring = self.monitoring.clone();
        let seen = self.seen_sessions.clone();

        tauri::async_runtime::spawn(async move {
            log::info!("Mötesdetektering startad");
            loop {
                if !monitoring.load(Ordering::SeqCst) {
                    break;
                }

                if let Some(session_id) = check_for_teams_meeting() {
                    let is_new = {
                        let mut set = seen.lock().unwrap();
                        set.insert(session_id.clone())
                    };

                    if is_new {
                        log::info!("Nytt Teams-möte upptäckt: {}", session_id);
                        send_meeting_notification(&app);
                    }
                }

                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
            log::info!("Mötesdetektering stoppad");
        });
    }

    pub fn stop_monitoring(&self) {
        self.monitoring.store(false, Ordering::SeqCst);
    }

    pub fn is_monitoring(&self) -> bool {
        self.monitoring.load(Ordering::SeqCst)
    }
}

fn send_meeting_notification(app: &AppHandle) {
    // Emit event so frontend can react
    let _ = app.emit("meeting-detected", ());

    // Send Windows toast notification
    use tauri_plugin_notification::NotificationExt;
    let result = app
        .notification()
        .builder()
        .title("Möte upptäckt")
        .body("Ett Teams-möte pågår. Vill du starta inspelning?")
        .show();

    if let Err(e) = result {
        log::warn!("Kunde inte visa notifiering: {}", e);
    }
}

/// Check for active Teams meeting windows using Win32 API.
/// Returns a session id (hash of window title + PID) if a meeting is found.
#[cfg(windows)]
fn check_for_teams_meeting() -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::sync::Mutex as StdMutex;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    struct WindowInfo {
        title: String,
        pid: u32,
    }

    static RESULTS: StdMutex<Vec<WindowInfo>> = StdMutex::new(Vec::new());

    // Meeting-related keywords in window titles
    const MEETING_KEYWORDS: &[&str] = &["meeting", "möte", "call", "samtal"];

    unsafe extern "system" fn enum_callback(hwnd: HWND, _: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() {
            let len = GetWindowTextLengthW(hwnd);
            if len > 0 {
                let mut buf = vec![0u16; (len + 1) as usize];
                let read = GetWindowTextW(hwnd, &mut buf);
                if read > 0 {
                    let title = OsString::from_wide(&buf[..read as usize])
                        .to_string_lossy()
                        .to_string();

                    let mut pid: u32 = 0;
                    GetWindowThreadProcessId(hwnd, Some(&mut pid));

                    if let Ok(mut results) = RESULTS.lock() {
                        results.push(WindowInfo { title, pid });
                    }
                }
            }
        }
        BOOL(1) // continue enumeration
    }

    // Clear previous results
    if let Ok(mut results) = RESULTS.lock() {
        results.clear();
    }

    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(0));
    }

    let results = RESULTS.lock().ok()?;

    for info in results.iter() {
        // Check if this is a Teams process
        if !is_teams_process(info.pid) {
            continue;
        }

        // Check if window title indicates a meeting
        let title_lower = info.title.to_lowercase();
        let is_meeting = MEETING_KEYWORDS.iter().any(|kw| title_lower.contains(kw));

        if is_meeting {
            let session_id = format!("{}_{}", info.pid, info.title);
            return Some(session_id);
        }
    }

    None
}

#[cfg(windows)]
fn is_teams_process(pid: u32) -> bool {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        let Ok(handle) = handle else {
            return false;
        };

        let mut buf = vec![0u16; 512];
        let len = GetModuleFileNameExW(handle, None, &mut buf);
        let _ = windows::Win32::Foundation::CloseHandle(handle);

        if len == 0 {
            return false;
        }

        let path = OsString::from_wide(&buf[..len as usize])
            .to_string_lossy()
            .to_lowercase();

        path.ends_with("ms-teams.exe") || path.ends_with("teams.exe")
    }
}

#[cfg(not(windows))]
fn check_for_teams_meeting() -> Option<String> {
    None
}
