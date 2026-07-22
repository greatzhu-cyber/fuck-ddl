use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

const BRIDGE_BIND_ADDRESS: &str = "127.0.0.1:0";
const MAX_LINE_BYTES: u64 = 64 * 1024;
const CONNECTION_READ_TIMEOUT: Duration = Duration::from_secs(2);
const BIND_RETRY_ATTEMPTS: usize = 20;
const BIND_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DomainEvent {
    #[serde(rename = "type")]
    kind: String,
    domain: String,
    observed_at: u64,
}

#[derive(Debug, Deserialize)]
struct BridgeEnvelope {
    token: String,
    event: DomainEvent,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeAcknowledgement {
    accepted: bool,
}

#[derive(Clone, Default)]
pub struct EdgeBridgeState {
    focus_active: Arc<AtomicBool>,
}

#[tauri::command]
pub fn set_edge_focus_active(state: State<'_, EdgeBridgeState>, active: bool) {
    state.focus_active.store(active, Ordering::SeqCst);
}

fn app_data_dir() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("com.fuckddl.desktop"))
}

fn ensure_token() -> Option<String> {
    let directory = app_data_dir()?;
    fs::create_dir_all(&directory).ok()?;
    let path = directory.join("edge-bridge.token");
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim();
        if existing.len() >= 32 {
            return Some(existing.to_owned());
        }
    }
    let token: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect();
    fs::write(path, &token).ok()?;
    Some(token)
}

fn write_endpoint(address: SocketAddr) -> bool {
    if !address.ip().is_loopback() || address.port() == 0 {
        return false;
    }
    let Some(directory) = app_data_dir() else {
        return false;
    };
    fs::create_dir_all(&directory).ok();
    fs::write(directory.join("edge-bridge.endpoint"), address.to_string()).is_ok()
}

fn valid_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 253
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn parse_authenticated_event(line: &[u8], token: &str) -> Option<DomainEvent> {
    if line.is_empty() || line.len() as u64 > MAX_LINE_BYTES || !line.ends_with(b"\n") {
        return None;
    }
    let envelope = serde_json::from_slice::<BridgeEnvelope>(line).ok()?;
    if envelope.token != token
        || !matches!(
            envelope.event.kind.as_str(),
            "domain-threshold" | "domain-left" | "bridge-ping"
        )
        || (envelope.event.kind == "bridge-ping" && envelope.event.domain != "local")
        || (envelope.event.kind != "bridge-ping" && !valid_domain(&envelope.event.domain))
    {
        return None;
    }
    Some(envelope.event)
}

fn read_authenticated_event(
    stream: TcpStream,
    token: &str,
    timeout: Duration,
) -> Option<DomainEvent> {
    stream.set_read_timeout(Some(timeout)).ok()?;
    let mut line = Vec::new();
    BufReader::new(stream)
        .take(MAX_LINE_BYTES + 1)
        .read_until(b'\n', &mut line)
        .ok()?;
    parse_authenticated_event(&line, token)
}

fn forwarded_event(event: &DomainEvent) -> Option<(&'static str, serde_json::Value)> {
    let event_name = match event.kind.as_str() {
        "domain-threshold" => "fuck-ddl:domain-threshold",
        "domain-left" => "fuck-ddl:domain-left",
        _ => return None,
    };
    Some((
        event_name,
        serde_json::json!({
            "domain": event.domain,
            "observedAt": event.observed_at,
        }),
    ))
}

fn write_acknowledgement(stream: &mut TcpStream, accepted: bool) {
    if let Ok(mut body) = serde_json::to_vec(&BridgeAcknowledgement { accepted }) {
        body.push(b'\n');
        let _ = stream.write_all(&body).and_then(|_| stream.flush());
    }
}

fn dispatch_to_ui(app: &tauri::AppHandle, event: &DomainEvent) -> bool {
    let Some((event_name, detail)) = forwarded_event(event) else {
        return event.kind == "bridge-ping";
    };
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let script = format!(
        "localStorage.setItem('fuck-ddl:active-distraction-domain', JSON.stringify({})); window.dispatchEvent(new CustomEvent({}, {{ detail: {} }}));",
        serde_json::to_string(&event.domain).unwrap_or_default(),
        serde_json::to_string(&event_name).unwrap_or_default(),
        detail
    );
    window.eval(&script).is_ok()
}

fn show_distraction_alert(app: &tauri::AppHandle, domain: &str) {
    let update_script = format!(
        "window.setDistractionDomain?.({});",
        serde_json::to_string(domain).unwrap_or_default()
    );
    if let Some(window) = app.get_webview_window("distraction-alert") {
        let _ = window.eval(&update_script);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        return;
    }

    if let Ok(window) = WebviewWindowBuilder::new(
        app,
        "distraction-alert",
        WebviewUrl::App("distraction-alert.html".into()),
    )
    .title("Fuck DDL · 摸鱼提醒")
    .inner_size(440.0, 260.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .center()
    .build()
    {
        let _ = window.eval(&update_script);
        let _ = window.set_focus();
    }
}

fn handle_connection(
    app: &tauri::AppHandle,
    mut stream: TcpStream,
    token: &str,
    focus_active: &AtomicBool,
) {
    let Ok(reader_stream) = stream.try_clone() else {
        return;
    };
    let Some(event) = read_authenticated_event(reader_stream, token, CONNECTION_READ_TIMEOUT)
    else {
        return;
    };
    let can_accept = event.kind != "domain-threshold" || focus_active.load(Ordering::SeqCst);
    let accepted = can_accept && dispatch_to_ui(app, &event);
    if accepted && event.kind == "domain-threshold" {
        show_distraction_alert(app, &event.domain);
    }
    write_acknowledgement(&mut stream, accepted);
}

pub fn start(app: tauri::AppHandle, state: EdgeBridgeState) {
    let Some(token) = ensure_token() else {
        return;
    };
    thread::spawn(move || {
        let Some(listener) =
            bind_listener_with_retry(BRIDGE_BIND_ADDRESS, BIND_RETRY_ATTEMPTS, BIND_RETRY_DELAY)
        else {
            return;
        };
        let Ok(address) = listener.local_addr() else {
            return;
        };
        if !write_endpoint(address) {
            return;
        }
        for stream in listener.incoming().flatten() {
            handle_connection(&app, stream, &token, &state.focus_active);
        }
    });
}

fn bind_listener_with_retry(
    address: &str,
    attempts: usize,
    retry_delay: Duration,
) -> Option<TcpListener> {
    for attempt in 0..attempts.max(1) {
        match TcpListener::bind(address) {
            Ok(listener) => return Some(listener),
            Err(_) if attempt + 1 < attempts.max(1) => thread::sleep(retry_delay),
            Err(_) => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        net::SocketAddr,
        time::{Duration, Instant},
    };

    const TEST_TOKEN: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address: SocketAddr = listener.local_addr().expect("read test listener address");
        let client = TcpStream::connect(address).expect("connect test client");
        let (server, _) = listener.accept().expect("accept test client");
        (client, server)
    }

    #[test]
    fn bridge_bind_retries_after_a_short_port_conflict() {
        let blocker = TcpListener::bind("127.0.0.1:0").expect("bind blocker");
        let address = blocker.local_addr().expect("read blocker address");
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(40));
            drop(blocker);
        });

        let listener =
            bind_listener_with_retry(&address.to_string(), 10, Duration::from_millis(10));
        release.join().expect("release blocker");
        assert!(listener.is_some());
    }

    #[test]
    fn domain_validation_rejects_url_details() {
        assert!(valid_domain("pintia.cn"));
        assert!(!valid_domain("https://pintia.cn/problem-sets"));
        assert!(!valid_domain("pintia.cn/path"));
        assert!(!valid_domain(".pintia.cn"));
        assert!(!valid_domain("pintia.cn."));
        assert!(!valid_domain("pintia..cn"));
        assert!(!valid_domain("-pintia.cn"));
    }

    #[test]
    fn production_listener_is_loopback_only() {
        let address: SocketAddr = BRIDGE_BIND_ADDRESS
            .parse()
            .expect("valid bridge bind address");
        assert!(address.ip().is_loopback());
        assert_eq!(address.port(), 0);
    }

    #[test]
    fn tcp_reader_authenticates_and_preserves_the_event_contract() {
        let (mut client, server) = tcp_pair();
        writeln!(
            client,
            r#"{{"token":"{TEST_TOKEN}","event":{{"type":"domain-threshold","domain":"video.example.com","observedAt":600000}}}}"#
        )
        .expect("write bridge envelope");

        let event = read_authenticated_event(server, TEST_TOKEN, Duration::from_secs(1))
            .expect("authenticated event");
        assert_eq!(event.kind, "domain-threshold");
        assert_eq!(event.domain, "video.example.com");
        assert_eq!(event.observed_at, 600_000);
        assert_eq!(
            forwarded_event(&event),
            Some((
                "fuck-ddl:domain-threshold",
                serde_json::json!({
                    "domain": "video.example.com",
                    "observedAt": 600_000,
                }),
            ))
        );

        let left = DomainEvent {
            kind: "domain-left".into(),
            domain: "video.example.com".into(),
            observed_at: 600_001,
        };
        assert_eq!(
            forwarded_event(&left),
            Some((
                "fuck-ddl:domain-left",
                serde_json::json!({
                    "domain": "video.example.com",
                    "observedAt": 600_001,
                }),
            ))
        );
    }

    #[test]
    fn rejects_wrong_tokens_unknown_events_and_oversized_lines() {
        let wrong_token =
            "{\"token\":\"wrong\",\"event\":{\"type\":\"domain-left\",\"domain\":\"video.example.com\",\"observedAt\":1}}\n";
        assert!(parse_authenticated_event(wrong_token.as_bytes(), TEST_TOKEN).is_none());

        let unknown_event = format!(
            "{{\"token\":\"{TEST_TOKEN}\",\"event\":{{\"type\":\"domain-title\",\"domain\":\"video.example.com\",\"observedAt\":1}}}}\n"
        );
        assert!(parse_authenticated_event(unknown_event.as_bytes(), TEST_TOKEN).is_none());

        let missing_newline = format!(
            "{{\"token\":\"{TEST_TOKEN}\",\"event\":{{\"type\":\"domain-left\",\"domain\":\"video.example.com\",\"observedAt\":1}}}}"
        );
        assert!(parse_authenticated_event(missing_newline.as_bytes(), TEST_TOKEN).is_none());

        let mut oversized = vec![b'a'; MAX_LINE_BYTES as usize];
        oversized.push(b'\n');
        assert!(parse_authenticated_event(&oversized, TEST_TOKEN).is_none());
    }

    #[test]
    fn bridge_ping_is_authenticated_but_never_forwarded_to_the_ui() {
        let ping = format!(
            "{{\"token\":\"{TEST_TOKEN}\",\"event\":{{\"type\":\"bridge-ping\",\"domain\":\"local\",\"observedAt\":1}}}}\n"
        );
        let event = parse_authenticated_event(ping.as_bytes(), TEST_TOKEN).expect("valid ping");
        assert!(forwarded_event(&event).is_none());
    }

    #[test]
    fn focus_state_is_explicit_and_defaults_to_inactive() {
        let state = EdgeBridgeState::default();
        assert!(!state.focus_active.load(Ordering::SeqCst));
        state.focus_active.store(true, Ordering::SeqCst);
        assert!(state.focus_active.load(Ordering::SeqCst));
    }

    #[test]
    fn acknowledgement_uses_a_bounded_line_protocol() {
        let (client, mut server) = tcp_pair();
        write_acknowledgement(&mut server, false);
        let mut line = String::new();
        BufReader::new(client)
            .read_line(&mut line)
            .expect("read acknowledgement");
        assert_eq!(line, "{\"accepted\":false}\n");
    }

    #[test]
    fn silent_clients_cannot_block_the_bridge_forever() {
        let (_client, server) = tcp_pair();
        let started = Instant::now();
        assert!(read_authenticated_event(server, TEST_TOKEN, Duration::from_millis(50)).is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
