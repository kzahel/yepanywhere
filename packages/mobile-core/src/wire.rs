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
            check(wire.plain_receive().await?["type"] == "client_connected")?;
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
