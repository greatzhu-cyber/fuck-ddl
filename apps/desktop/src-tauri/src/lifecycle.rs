use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::Duration,
};

use tauri::{AppHandle, Manager};

const INSTANCE_ADDRESS: &str = "127.0.0.1:37931";
const INSTANCE_SIGNAL: &[u8] = b"FUCKDDL_SHOW_V1";
const INSTANCE_ACK: &[u8] = b"FUCKDDL_OK_V1";

pub struct SingleInstanceGuard {
    _listener: TcpListener,
}

fn activate_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn notify_existing_instance() -> Result<bool, String> {
    let mut stream = TcpStream::connect_timeout(
        &INSTANCE_ADDRESS
            .parse()
            .map_err(|_| "single-instance-address-invalid".to_string())?,
        Duration::from_millis(350),
    )
    .map_err(|error| format!("single-instance-connect-failed:{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(350)))
        .map_err(|error| format!("single-instance-timeout-failed:{error}"))?;
    stream
        .write_all(INSTANCE_SIGNAL)
        .map_err(|error| format!("single-instance-write-failed:{error}"))?;
    let mut acknowledgement = [0_u8; INSTANCE_ACK.len()];
    stream
        .read_exact(&mut acknowledgement)
        .map_err(|error| format!("single-instance-read-failed:{error}"))?;
    Ok(acknowledgement == INSTANCE_ACK)
}

pub fn acquire_single_instance(app: AppHandle) -> Result<Option<SingleInstanceGuard>, String> {
    match TcpListener::bind(INSTANCE_ADDRESS) {
        Ok(listener) => {
            listener
                .set_nonblocking(true)
                .map_err(|error| format!("single-instance-nonblocking-failed:{error}"))?;
            let thread_listener = listener
                .try_clone()
                .map_err(|error| format!("single-instance-clone-failed:{error}"))?;
            thread::spawn(move || loop {
                match thread_listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut signal = [0_u8; INSTANCE_SIGNAL.len()];
                        if stream.read_exact(&mut signal).is_ok() && signal == INSTANCE_SIGNAL {
                            activate_main_window(&app);
                            let _ = stream.write_all(INSTANCE_ACK);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(80));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(160)),
                }
            });
            Ok(Some(SingleInstanceGuard {
                _listener: listener,
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => notify_existing_instance()
            .and_then(|activated| {
                activated
                    .then_some(None)
                    .ok_or_else(|| "single-instance-port-conflict".to_string())
            }),
        Err(error) => Err(format!("single-instance-bind-failed:{error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_handshake_is_bounded_and_specific() {
        assert_eq!(INSTANCE_SIGNAL.len(), 15);
        assert_eq!(INSTANCE_ACK.len(), 13);
        assert_ne!(INSTANCE_SIGNAL, INSTANCE_ACK);
    }
}
