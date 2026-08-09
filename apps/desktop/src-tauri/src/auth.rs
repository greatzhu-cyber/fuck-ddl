use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use url::Url;

pub const DESKTOP_OAUTH_CALLBACK_EVENT: &str = "fuck-ddl:desktop-oauth-callback";
const DESKTOP_OAUTH_CALLBACK_PORT: u16 = 43123;
const DESKTOP_OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct DesktopOAuthCallbackState {
    active: Arc<AtomicBool>,
}

fn callback_payload(request_target: &str) -> Value {
    let parsed = Url::parse(&format!("http://127.0.0.1{request_target}"));
    let mut payload = json!({});
    if let Ok(url) = parsed {
        for (key, value) in url.query_pairs() {
            if matches!(key.as_ref(), "code" | "error" | "error_description") {
                payload[key.as_ref()] = Value::String(value.into_owned());
            }
        }
    }
    payload
}

fn request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = [0_u8; 8192];
    let bytes_read = stream.read(&mut buffer).ok()?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .map(str::to_owned)
}

fn respond(stream: &mut TcpStream) {
    let body = "<!doctype html><meta charset=\"utf-8\"><title>Fuck DDL</title><p>登录已完成，请返回 Fuck DDL。</p>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

#[tauri::command]
pub fn start_desktop_oauth_callback(
    app: AppHandle,
    state: State<'_, DesktopOAuthCallbackState>,
) -> Result<String, String> {
    let callback_url = format!("http://127.0.0.1:{DESKTOP_OAUTH_CALLBACK_PORT}/auth/callback");
    if state.active.swap(true, Ordering::AcqRel) {
        return Ok(callback_url);
    }

    let listener = match TcpListener::bind(("127.0.0.1", DESKTOP_OAUTH_CALLBACK_PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            state.active.store(false, Ordering::Release);
            return Err(format!("无法启动桌面登录回调：{error}"));
        }
    };
    if let Err(error) = listener.set_nonblocking(true) {
        state.active.store(false, Ordering::Release);
        return Err(format!("无法设置桌面登录回调：{error}"));
    }
    let active = state.active.clone();
    thread::spawn(move || {
        let deadline = Instant::now() + DESKTOP_OAUTH_CALLBACK_TIMEOUT;
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let target = request_target(&mut stream).unwrap_or_else(|| "/".to_owned());
                    respond(&mut stream);
                    let _ = app.emit(DESKTOP_OAUTH_CALLBACK_EVENT, callback_payload(&target));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    thread::sleep(Duration::from_millis(80));
                }
                Err(_) => break,
            }
        }
        active.store(false, Ordering::Release);
    });

    Ok(callback_url)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|error| format!("无效的登录地址：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只允许打开 HTTP 或 HTTPS 登录地址。".to_owned());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .spawn()
            .map_err(|error| format!("无法打开系统浏览器：{error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = parsed;
        Err("当前桌面 OAuth 仅支持 Windows 系统浏览器。".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::callback_payload;

    #[test]
    fn callback_payload_keeps_only_oauth_fields() {
        assert_eq!(
            callback_payload("/auth/callback?code=abc123&state=ignored&error_description=denied"),
            serde_json::json!({
                "code": "abc123",
                "error_description": "denied"
            })
        );
    }

    #[test]
    fn callback_payload_decodes_query_values() {
        assert_eq!(
            callback_payload("/auth/callback?error=access_denied&error_description=No+invite"),
            serde_json::json!({
                "error": "access_denied",
                "error_description": "No invite"
            })
        );
    }
}
