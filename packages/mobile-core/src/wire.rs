use crate::{Error, Result, check, crypto::*};
use futures_util::{SinkExt, StreamExt};
use rustls_platform_verifier::BuilderVerifierExt;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
#[cfg(test)]
use tokio::sync::oneshot;
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use url::Url;

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub struct Wire {
    socket: Option<Socket>,
    circuit: Option<crate::mux::Circuit>,
    #[cfg(test)]
    flush_gate: Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>,
}
fn tls() -> Result<Arc<rustls::ClientConfig>> {
    let builder = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| Error::Unavailable)?;
    Ok(Arc::new(
        builder
            .with_platform_verifier()
            .map_err(|_| Error::Unavailable)?
            .with_no_client_auth(),
    ))
}
impl Wire {
    async fn open(url: &Url) -> Result<Self> {
        Ok(Self {
            socket: Some(open_socket(url, 65536).await?),
            circuit: None,
            #[cfg(test)]
            flush_gate: None,
        })
    }
    pub async fn authenticated(mut self) -> Self {
        if let Some(circuit) = &self.circuit {
            circuit.authenticated();
        }
        if let Some(socket) = self.socket.take() {
            let mut config = WebSocketConfig::default();
            config.max_message_size = Some(MAX_BYTES + 64);
            config.max_frame_size = Some(MAX_BYTES + 64);
            config.max_write_buffer_size = MAX_BYTES + 128 * 1024;
            self.socket = Some(
                WebSocketStream::from_raw_socket(
                    socket.into_inner(),
                    tokio_tungstenite::tungstenite::protocol::Role::Client,
                    Some(config),
                )
                .await,
            );
        }
        self
    }
    pub async fn connect(endpoint: &str, target: Option<&str>) -> Result<Self> {
        let url = Url::parse(endpoint).map_err(|_| Error::InvalidMessage)?;
        check(
            matches!(url.scheme(), "ws" | "wss")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
        )?;
        if let Some(target) = target {
            check(!target.is_empty() && target.len() <= 128)?;
            // Probe only eligible relay /ws URLs. An explicit custom endpoint
            // is authoritative; a failed setup falls back to that exact URL.
            if url.path().ends_with("/ws")
                && url.query().is_none()
                && Self::mux_capability(&url).await.unwrap_or(false)
                && let Ok(wire) = crate::mux::Circuit::connect(&url, target).await
            {
                return Ok(Self {
                    socket: None,
                    circuit: Some(wire),
                    #[cfg(test)]
                    flush_gate: None,
                });
            }
            let mut wire = Self::open(&url).await?;
            wire.plain_send(&json!({"type":"client_connect","username":target}))
                .await?;
            let reply = wire.plain_receive().await?;
            // The relay knows the host, which is not connected to it right
            // now: an outage to retry, not a peer that failed verification.
            if reply["type"] == "client_error" && reply["reason"] == "server_offline" {
                return Err(Error::Unavailable);
            }
            check(reply["type"] == "client_connected")?;
            Ok(wire)
        } else {
            Self::open(&url).await
        }
    }
    async fn mux_capability(url: &Url) -> Result<bool> {
        let mut health = url.clone();
        health
            .set_scheme(if url.scheme() == "wss" {
                "https"
            } else {
                "http"
            })
            .map_err(|_| Error::InvalidMessage)?;
        health.set_path(&format!("{}/health", url.path().trim_end_matches("/ws")));
        let client = reqwest::Client::builder()
            .use_preconfigured_tls((*tls()?).clone())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| Error::Unavailable)?;
        let response = client
            .get(health)
            .send()
            .await
            .map_err(|_| Error::Unavailable)?;
        check(response.status().is_success())?;
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Error::Unavailable)?;
            check(bytes.len() + chunk.len() <= 65536)?;
            bytes.extend_from_slice(&chunk);
        }
        let v: Value = serde_json::from_slice(&bytes)?;
        Ok(v["relayCapabilities"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x == "client-mux-v1")))
    }
    async fn send(&mut self, bytes: Vec<u8>, binary: bool) -> Result<()> {
        check(bytes.len() <= MAX_BYTES + 48)?;
        if let Some(circuit) = &self.circuit {
            return circuit.send(bytes, binary).await;
        }
        let message = if binary {
            Message::Binary(bytes.into())
        } else {
            Message::Text(
                String::from_utf8(bytes)
                    .map_err(|_| Error::InvalidMessage)?
                    .into(),
            )
        };
        let socket = self.socket.as_mut().ok_or(Error::Closed)?;
        timeout(Duration::from_secs(30), async {
            #[cfg(test)]
            if let Some((buffered, release)) = self.flush_gate.take() {
                socket.feed(message).await?;
                let _ = buffered.send(());
                let _ = release.await;
                return socket.flush().await;
            }
            socket.send(message).await
        })
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Unavailable)
    }
    #[cfg(test)]
    pub(crate) fn pause_next_flush(&mut self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (buffered, wait_for_buffer) = oneshot::channel();
        let (release, wait_for_release) = oneshot::channel();
        self.flush_gate = Some((buffered, wait_for_release));
        (wait_for_buffer, release)
    }
    async fn receive(&mut self) -> Result<(Vec<u8>, bool)> {
        if let Some(circuit) = &mut self.circuit {
            return circuit.receive().await;
        }
        loop {
            let message = self
                .socket
                .as_mut()
                .ok_or(Error::Closed)?
                .next()
                .await
                .ok_or(Error::Unavailable)?
                .map_err(|_| Error::Unavailable)?;
            match message {
                Message::Ping(bytes) => self
                    .socket
                    .as_mut()
                    .ok_or(Error::Closed)?
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| Error::Unavailable)?,
                Message::Pong(_) => {}
                Message::Binary(bytes) => return Ok((bytes.to_vec(), true)),
                Message::Text(text) => return Ok((text.as_bytes().to_vec(), false)),
                _ => return Err(Error::Unavailable),
            }
        }
    }
    pub async fn plain_send(&mut self, v: &Value) -> Result<()> {
        self.send(serde_json::to_vec(v)?, false).await
    }
    pub async fn plain_receive(&mut self) -> Result<Value> {
        let (bytes, binary) = timeout(Duration::from_secs(15), self.receive())
            .await
            .map_err(|_| Error::Timeout)??;
        check(!binary && bytes.len() <= 65536)?;
        let v: Value = serde_json::from_slice(&bytes)?;
        if v["type"] == "srp_invalid" || v["type"] == "srp_resume_failed" {
            return Err(Error::ReauthenticationRequired);
        }
        check(v["type"] != "srp_error")?;
        Ok(v)
    }
    pub async fn encrypted_send(&mut self, bytes: &[u8], key: &[u8]) -> Result<()> {
        let nonce = random(24)?;
        let mut envelope = vec![1];
        envelope.extend_from_slice(&nonce);
        envelope.extend_from_slice(&seal(bytes, &nonce, key)?);
        self.send(envelope, true).await
    }
    pub async fn encrypted_receive(&mut self, key: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let (bytes, binary) = self.receive().await?;
        check(binary && bytes.len() >= 42 && bytes[0] == 1)?;
        open(&bytes[25..], &bytes[1..25], key)
    }
}
use zeroize::Zeroizing;

pub(crate) async fn open_socket(url: &Url, budget: usize) -> Result<Socket> {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(budget);
    config.max_frame_size = Some(budget);
    config.max_write_buffer_size = MAX_BYTES + 128 * 1024;
    let (socket, _) = timeout(
        Duration::from_secs(10),
        connect_async_tls_with_config(
            url.as_str(),
            Some(config),
            true,
            Some(Connector::Rustls(tls()?)),
        ),
    )
    .await
    .map_err(|_| Error::Timeout)?
    .map_err(|_| Error::Unavailable)?;
    Ok(socket)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        task::JoinHandle,
    };
    use tokio_tungstenite::accept_async;

    /// A relay that advertises the shared socket, refuses every circuit open
    /// with `refusal`, and answers the first dedicated-socket claim with
    /// `reply`. Yields the number of circuits it refused before that claim.
    async fn fake_relay(refusal: &'static str, reply: Value) -> (String, JoinHandle<u32>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/ws", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut refused = 0;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut head = [0u8; 11];
                while stream.peek(&mut head).await.unwrap() < head.len() {
                    tokio::task::yield_now().await;
                }
                if &head == b"GET /health" {
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        request.push(stream.read_u8().await.unwrap());
                    }
                    let body = r#"{"relayCapabilities":["client-mux-v1"]}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                    continue;
                }
                let mut socket = accept_async(stream).await.unwrap();
                if head.starts_with(b"GET /ws ") {
                    let Some(Ok(Message::Text(text))) = socket.next().await else {
                        panic!("dedicated socket sent no claim");
                    };
                    let claim: Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(claim, json!({"type":"client_connect","username":"host"}));
                    socket.send(Message::text(reply.to_string())).await.unwrap();
                    return refused;
                }
                assert!(head.starts_with(b"GET /mux "));
                let ready = json!({"type":"mux_ready","protocolVersion":1,"maxCircuits":5,"maxFrameBytes":65536});
                socket.send(Message::text(ready.to_string())).await.unwrap();
                let Some(Ok(Message::Text(text))) = socket.next().await else {
                    panic!("shared socket sent no open");
                };
                let open: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(open["type"], "mux_open");
                let error =
                    json!({"type":"mux_error","circuitId":open["circuitId"],"reason":refusal});
                socket.send(Message::text(error.to_string())).await.unwrap();
                refused += 1;
                // Keep the shared socket open, as a relay does for its peers.
                tokio::spawn(async move { while socket.next().await.is_some() {} });
            }
        });
        (endpoint, task)
    }
    async fn connect(endpoint: &str) -> Result<Wire> {
        timeout(
            Duration::from_secs(5),
            Wire::connect(endpoint, Some("host")),
        )
        .await
        .unwrap()
    }

    // Exhausted recovery can ask for more circuits than a relay admits in a
    // minute (topics/source-transport.md). The refusal must cost the shared
    // socket, not the connection.
    #[tokio::test]
    async fn refused_circuit_open_falls_back_to_a_dedicated_socket() {
        let (endpoint, relay) =
            fake_relay("rate_limited", json!({"type":"client_connected"})).await;
        let wire = connect(&endpoint).await.unwrap();
        assert!(wire.circuit.is_none() && wire.socket.is_some());
        assert_eq!(relay.await.unwrap(), 1);
    }

    // Callers end recovery on InvalidMessage, so a host that is merely away
    // from its relay must not produce it.
    #[tokio::test]
    async fn host_away_from_its_relay_is_an_outage_and_an_unknown_host_is_not() {
        let offline = json!({"type":"client_error","reason":"server_offline"});
        let (endpoint, relay) = fake_relay("server_offline", offline).await;
        assert!(matches!(connect(&endpoint).await, Err(Error::Unavailable)));
        assert_eq!(relay.await.unwrap(), 1);

        let unknown = json!({"type":"client_error","reason":"unknown_username"});
        let (endpoint, _relay) = fake_relay("unknown_username", unknown).await;
        assert!(matches!(
            connect(&endpoint).await,
            Err(Error::InvalidMessage)
        ));
    }
}
