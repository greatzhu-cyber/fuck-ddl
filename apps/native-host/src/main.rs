use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    time::Duration,
};

const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DomainEvent {
    #[serde(rename = "type")]
    kind: String,
    domain: String,
    observed_at: u64,
}

#[derive(Serialize)]
struct BridgeEnvelope<'a> {
    token: &'a str,
    event: &'a DomainEvent,
}

#[derive(Debug, Deserialize)]
struct BridgeAcknowledgement {
    accepted: bool,
}

#[derive(Serialize)]
struct HostResponse<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

fn app_data_dir() -> Result<PathBuf, &'static str> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("com.fuckddl.desktop"))
        .ok_or("local-app-data-unavailable")
}

fn read_bridge_address() -> Result<SocketAddr, &'static str> {
    let endpoint_path = app_data_dir()?.join("edge-bridge.endpoint");
    let endpoint = fs::read_to_string(endpoint_path).map_err(|_| "desktop-endpoint-unavailable")?;
    parse_bridge_address(&endpoint)
}

fn parse_bridge_address(endpoint: &str) -> Result<SocketAddr, &'static str> {
    let address = endpoint
        .trim()
        .parse::<SocketAddr>()
        .map_err(|_| "desktop-endpoint-invalid")?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err("desktop-endpoint-invalid");
    }
    Ok(address)
}

fn read_native_message<R: Read>(reader: &mut R) -> Result<Vec<u8>, &'static str> {
    let mut size = [0_u8; 4];
    reader.read_exact(&mut size).map_err(|_| "invalid-frame")?;
    let length = u32::from_le_bytes(size) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err("invalid-frame-size");
    }
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|_| "incomplete-frame")?;
    Ok(body)
}

fn write_native_message<W: Write, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), &'static str> {
    let body = serde_json::to_vec(value).map_err(|_| "response-encode-failed")?;
    writer
        .write_all(&(body.len() as u32).to_le_bytes())
        .and_then(|_| writer.write_all(&body))
        .and_then(|_| writer.flush())
        .map_err(|_| "response-write-failed")
}

fn valid_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 253
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
}

fn valid_event(event: &DomainEvent) -> bool {
    (matches!(event.kind.as_str(), "domain-threshold" | "domain-left")
        && valid_domain(&event.domain))
        || (event.kind == "bridge-ping" && event.domain == "local")
}

fn forward(event: &DomainEvent) -> Result<(), &'static str> {
    let token_path = app_data_dir()?.join("edge-bridge.token");
    let token = fs::read_to_string(token_path).map_err(|_| "desktop-token-unavailable")?;
    let token = token.trim();
    if token.len() < 32 {
        return Err("desktop-token-invalid");
    }
    let address = read_bridge_address()?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "desktop-unavailable")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "bridge-timeout-failed")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "bridge-timeout-failed")?;
    let mut body =
        serde_json::to_vec(&BridgeEnvelope { token, event }).map_err(|_| "bridge-encode-failed")?;
    body.push(b'\n');
    stream
        .write_all(&body)
        .and_then(|_| stream.flush())
        .map_err(|_| "bridge-write-failed")?;
    let mut response = String::new();
    BufReader::new(&mut stream)
        .read_line(&mut response)
        .map_err(|_| "bridge-response-failed")?;
    let acknowledgement: BridgeAcknowledgement =
        serde_json::from_str(&response).map_err(|_| "bridge-response-invalid")?;
    if acknowledgement.accepted {
        Ok(())
    } else {
        Err("desktop-not-focusing")
    }
}

fn run() -> Result<(), &'static str> {
    let body = read_native_message(&mut io::stdin().lock())?;
    let event: DomainEvent = serde_json::from_slice(&body).map_err(|_| "invalid-json")?;
    if !valid_event(&event) {
        return Err("invalid-event");
    }
    forward(&event)
}

fn main() {
    let result = run();
    let response = match result {
        Ok(()) => HostResponse {
            ok: true,
            error: None,
        },
        Err(error) => HostResponse {
            ok: false,
            error: Some(error),
        },
    };
    let _ = write_native_message(&mut io::stdout().lock(), &response);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_hostname_but_rejects_url_content() {
        assert!(valid_domain("courses.zju.edu.cn"));
        assert!(!valid_domain("https://example.com/private?q=secret"));
        assert!(!valid_domain("example.com/path"));
    }

    #[test]
    fn accepts_only_the_fixed_local_bridge_ping() {
        assert!(valid_event(&DomainEvent {
            kind: "bridge-ping".into(),
            domain: "local".into(),
            observed_at: 1,
        }));
        assert!(!valid_event(&DomainEvent {
            kind: "bridge-ping".into(),
            domain: "example.com".into(),
            observed_at: 1,
        }));
    }

    #[test]
    fn bridge_endpoint_must_be_a_bounded_loopback_socket() {
        assert_eq!(
            parse_bridge_address("127.0.0.1:49000").unwrap(),
            "127.0.0.1:49000".parse::<SocketAddr>().unwrap()
        );
        assert!(parse_bridge_address("0.0.0.0:49000").is_err());
        assert!(parse_bridge_address("192.168.1.2:49000").is_err());
        assert!(parse_bridge_address("127.0.0.1:0").is_err());
        assert!(parse_bridge_address("not-an-endpoint").is_err());
    }

    #[test]
    fn reads_native_messaging_frame() {
        let body = br#"{"type":"domain-threshold","domain":"example.com","observedAt":1}"#;
        let mut frame = Vec::from((body.len() as u32).to_le_bytes());
        frame.extend_from_slice(body);
        assert_eq!(read_native_message(&mut frame.as_slice()).unwrap(), body);
    }

    #[test]
    fn rejects_oversized_frames() {
        let mut frame = Vec::from(((MAX_MESSAGE_BYTES + 1) as u32).to_le_bytes());
        frame.extend_from_slice(b"{}");
        assert_eq!(
            read_native_message(&mut frame.as_slice()).unwrap_err(),
            "invalid-frame-size"
        );
    }

    #[test]
    fn bridge_acknowledgement_requires_desktop_acceptance() {
        let accepted: BridgeAcknowledgement = serde_json::from_str(r#"{"accepted":true}"#).unwrap();
        let deferred: BridgeAcknowledgement =
            serde_json::from_str(r#"{"accepted":false}"#).unwrap();
        assert!(accepted.accepted);
        assert!(!deferred.accepted);
    }
}
