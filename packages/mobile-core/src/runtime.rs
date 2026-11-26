//! One authenticated source per native profile, with independently scoped demand.
use crate::{
    CredentialPersistence, Error, NativeRoute, NativeSecurityBinding, NativeSession, Result,
    SessionOptions, check, parse,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const QUEUE_BYTES: usize = 64 * 1024 * 1024;
struct Event {
    text: String,
    coalesce: Option<String>,
    terminal: bool,
    budget: Arc<AtomicUsize>,
}
impl Drop for Event {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.text.len(), Ordering::AcqRel);
    }
}
struct Owner {
    id: String,
    cancel: CancellationToken,
    overflow: AtomicBool,
    events: Mutex<VecDeque<Event>>,
    wake: Notify,
}
impl Owner {
    fn event(&self, value: Value, budget: &Arc<AtomicUsize>) -> Result<()> {
        let text = value.to_string();
        let coalesce = match value["type"].as_str() {
            Some("state") => Some("state".into()),
            Some("upload_progress") => value["uploadId"].as_str().map(|id| format!("upload:{id}")),
            _ => None,
        };
        let mut events = self.events.lock().map_err(|_| Error::Closed)?;
        if self.cancel.is_cancelled() {
            return Err(Error::Closed);
        }
        if let Some(key) = &coalesce {
            events.retain(|event| event.coalesce.as_ref() != Some(key));
        }
        if events.len() >= 64
            || events.iter().map(|e| e.text.len()).sum::<usize>() + text.len() > 32 * 1024 * 1024
        {
            return Err(Error::Overflow);
        }
        budget
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(text.len()).filter(|n| *n <= QUEUE_BYTES)
            })
            .map_err(|_| Error::Overflow)?;
        let terminal = value["type"] == "state"
            && matches!(
                value["phase"].as_str(),
                Some("FAILED" | "REAUTHENTICATION_REQUIRED")
            );
        events.push_back(Event {
            text,
            coalesce,
            terminal,
            budget: budget.clone(),
        });
        self.wake.notify_one();
        Ok(())
    }
}
#[derive(Clone, PartialEq)]
enum Kind {
    Subscription,
    Upload,
}
#[derive(Clone)]
struct Resource {
    owner: String,
    local: String,
    kind: Kind,
}
struct Source {
    session: Arc<NativeSession>,
    first_route: String,
    owners: Mutex<HashMap<String, Weak<Owner>>>,
    resources: Mutex<HashMap<String, Resource>>,
    cleanup: mpsc::Sender<(String, Kind)>,
    cancel: CancellationToken,
}
impl Drop for Source {
    fn drop(&mut self) {
        self.shutdown();
    }
}
impl Source {
    fn start(
        session: Arc<NativeSession>,
        first_route: String,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        let (cleanup, mut cleanups) = mpsc::channel(128);
        let source = Arc::new(Self {
            session: session.clone(),
            first_route,
            owners: Mutex::new(HashMap::new()),
            resources: Mutex::new(HashMap::new()),
            cleanup,
            cancel: cancel.clone(),
        });
        let weak = Arc::downgrade(&source);
        let budget = Arc::new(AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    _ = cancel.cancelled() => break,
                    cleanup = cleanups.recv() => {
                        let Some((id, kind)) = cleanup else { break; };
                        let (method, params) = match kind { Kind::Subscription => ("unsubscribe", json!({"subscriptionId":id})), Kind::Upload => ("uploadCancel", json!({"uploadId":id})) };
                        tokio::select! { _ = cancel.cancelled() => break, _ = session.dispatch(method.into(), params.to_string()) => {} }
                        continue;
                    },
                    event = session.next_event() => event,
                };
                let Some(source) = weak.upgrade() else {
                    break;
                };
                match event.and_then(|text| parse(&text, crate::crypto::MAX_BYTES)) {
                    Ok(mut value) => {
                        if let Some((wire, field)) = value["subscriptionId"]
                            .as_str()
                            .map(|id| (id.to_owned(), "subscriptionId"))
                            .or_else(|| {
                                value["uploadId"]
                                    .as_str()
                                    .map(|id| (id.to_owned(), "uploadId"))
                            })
                        {
                            let resource =
                                source.resources.lock().ok().and_then(|mut resources| {
                                    let resource = resources.get(&wire)?.clone();
                                    if matches!(
                                        value["type"].as_str(),
                                        Some(
                                            "subscriptionError"
                                                | "upload_complete"
                                                | "upload_error"
                                        )
                                    ) {
                                        resources.remove(&wire);
                                    }
                                    Some(resource)
                                });
                            if let Some(resource) = resource {
                                value[field] = json!(resource.local);
                                let owner = source.owners.lock().ok().and_then(|owners| {
                                    owners.get(&resource.owner).and_then(Weak::upgrade)
                                });
                                if let Some(owner) = owner {
                                    source.deliver(&owner, value, &budget);
                                }
                            }
                        } else if value["type"] == "state" {
                            let owners = source
                                .owners
                                .lock()
                                .map(|owners| {
                                    owners
                                        .values()
                                        .filter_map(Weak::upgrade)
                                        .collect::<Vec<_>>()
                                })
                                .unwrap_or_default();
                            for owner in owners {
                                source.deliver(&owner, value.clone(), &budget);
                            }
                        }
                    }
                    Err(_) => {
                        source.stop(true);
                        break;
                    }
                }
            }
            session.close();
        });
        source
    }
    fn deliver(&self, owner: &Arc<Owner>, value: Value, budget: &Arc<AtomicUsize>) {
        while !owner.cancel.is_cancelled() {
            match owner.event(value.clone(), budget) {
                Ok(()) | Err(Error::Closed) => break,
                Err(_) => {}
            }
            let bytes = value.to_string().len();
            let local_full = owner.events.lock().map_or(true, |events| {
                events.len() >= 64
                    || events.iter().map(|e| e.text.len()).sum::<usize>() + bytes > 32 * 1024 * 1024
            });
            let victim = if local_full {
                owner.clone()
            } else {
                self.owners
                    .lock()
                    .ok()
                    .and_then(|owners| {
                        owners
                            .values()
                            .filter_map(Weak::upgrade)
                            .filter(|candidate| !candidate.cancel.is_cancelled())
                            .max_by_key(|candidate| {
                                candidate.events.lock().map_or(0, |events| {
                                    events.iter().map(|e| e.text.len()).sum::<usize>()
                                })
                            })
                    })
                    .unwrap_or_else(|| owner.clone())
            };
            victim.overflow.store(true, Ordering::Release);
            self.release(&victim);
        }
    }
    fn shutdown(&self) {
        self.stop(false);
    }
    fn stop(&self, preserve_terminal: bool) {
        self.cancel.cancel();
        self.session.close();
        if let Ok(owners) = self.owners.lock() {
            for owner in owners.values().filter_map(Weak::upgrade) {
                owner.cancel.cancel();
                if let Ok(mut events) = owner.events.lock() {
                    events.retain(|event| preserve_terminal && event.terminal);
                }
                owner.wake.notify_one();
            }
        }
    }
    fn lease(self: &Arc<Self>) -> Result<Arc<NativeSourceLease>> {
        let owner = Arc::new(Owner {
            id: Uuid::new_v4().to_string(),
            cancel: CancellationToken::new(),
            overflow: AtomicBool::new(false),
            events: Mutex::new(VecDeque::new()),
            wake: Notify::new(),
        });
        let mut owners = self.owners.lock().map_err(|_| Error::Closed)?;
        if self.cancel.is_cancelled() {
            return Err(Error::Closed);
        }
        owners.retain(|_, owner| owner.strong_count() > 0);
        if owners.len() >= 64 {
            return Err(Error::Overflow);
        }
        owners.insert(owner.id.clone(), Arc::downgrade(&owner));
        Ok(Arc::new(NativeSourceLease {
            source: self.clone(),
            owner,
            reader: tokio::sync::Mutex::new(()),
        }))
    }
    fn release(&self, owner: &Owner) {
        owner.cancel.cancel();
        owner.wake.notify_one();
        if let Ok(mut events) = owner.events.lock() {
            events.clear();
        }
        if let Ok(mut resources) = self.resources.lock() {
            resources.retain(|id, resource| {
                if resource.owner != owner.id {
                    return true;
                }
                let _ = self.cleanup.try_send((id.clone(), resource.kind.clone()));
                false
            });
        }
        let last = self
            .owners
            .lock()
            .map(|mut owners| {
                owners.remove(&owner.id);
                owners.retain(|_, owner| {
                    owner
                        .upgrade()
                        .is_some_and(|owner| !owner.cancel.is_cancelled())
                });
                owners.is_empty()
            })
            .unwrap_or(true);
        if last {
            self.shutdown();
        }
    }
    fn resource(&self, owner: &str, local: &str, kind: Kind) -> Result<String> {
        self.resources
            .lock()
            .map_err(|_| Error::Closed)?
            .iter()
            .find(|(_, r)| r.owner == owner && r.local == local && r.kind == kind)
            .map(|(wire, _)| wire.clone())
            .ok_or(Error::InvalidMessage)
    }
}
struct ResourceGuard {
    source: Weak<Source>,
    wire: String,
    kind: Kind,
    armed: bool,
}
impl Drop for ResourceGuard {
    fn drop(&mut self) {
        if self.armed
            && let Some(source) = self.source.upgrade()
            && let Ok(mut resources) = source.resources.lock()
            && resources.remove(&self.wire).is_some()
        {
            let _ = source
                .cleanup
                .try_send((self.wire.clone(), self.kind.clone()));
        }
    }
}

#[derive(uniffi::Object)]
pub struct NativeSourceLease {
    source: Arc<Source>,
    owner: Arc<Owner>,
    reader: tokio::sync::Mutex<()>,
}
impl Drop for NativeSourceLease {
    fn drop(&mut self) {
        self.source.release(&self.owner);
    }
}
#[uniffi::export(async_runtime = "tokio")]
impl NativeSourceLease {
    pub fn release(&self) {
        self.source.release(&self.owner);
    }
    pub fn credential_data(&self) -> Result<Vec<u8>> {
        self.open()?;
        self.source.session.credential_data()
    }
    pub fn security_binding(&self) -> Result<NativeSecurityBinding> {
        self.open()?;
        self.source.session.security_binding()
    }
    pub fn route_id(&self) -> Result<String> {
        self.open()?;
        let id = self.source.session.route_id()?;
        Ok(if id.is_empty() {
            self.source.first_route.clone()
        } else {
            id
        })
    }
    pub async fn dispatch(&self, method: String, params: String) -> Result<String> {
        self.open()?;
        let mut params = parse(&params, 512 * 1024)?;
        let operation = match method.as_str() {
            "subscribe" => Some(("subscriptionId", Kind::Subscription, true)),
            "unsubscribe" => Some(("subscriptionId", Kind::Subscription, false)),
            "uploadStart" => Some(("uploadId", Kind::Upload, true)),
            "uploadEnd" | "uploadCancel" => Some(("uploadId", Kind::Upload, false)),
            "request" => None,
            _ => return Err(Error::InvalidMessage),
        };
        let mut guard = None;
        if let Some((field, kind, start)) = operation {
            let local = crate::crypto::field(&params, field)?.to_owned();
            check(!local.is_empty() && local.len() <= 128)?;
            if kind == Kind::Upload {
                Uuid::parse_str(&local).map_err(|_| Error::InvalidMessage)?;
            }
            let wire = if start {
                let mut resources = self.source.resources.lock().map_err(|_| Error::Closed)?;
                check(
                    !resources
                        .values()
                        .any(|r| r.owner == self.owner.id && r.local == local && r.kind == kind),
                )?;
                // Retiring resources retain admission until the cleanup actor
                // consumes them. Rapid owner churn cannot overflow its queue.
                if resources.len() + (128 - self.source.cleanup.capacity()) >= 68 {
                    return Err(Error::Overflow);
                }
                if kind == Kind::Upload {
                    check(
                        resources
                            .values()
                            .filter(|r| r.owner == self.owner.id && r.kind == Kind::Upload)
                            .count()
                            < 4,
                    )?;
                }
                let wire = Uuid::new_v4().to_string();
                resources.insert(
                    wire.clone(),
                    Resource {
                        owner: self.owner.id.clone(),
                        local,
                        kind: kind.clone(),
                    },
                );
                wire
            } else {
                self.source.resource(&self.owner.id, &local, kind.clone())?
            };
            if start || method == "unsubscribe" || method == "uploadCancel" {
                guard = Some(ResourceGuard {
                    source: Arc::downgrade(&self.source),
                    wire: wire.clone(),
                    kind,
                    armed: true,
                });
            }
            params[field] = json!(wire);
        }
        let result = tokio::select! { _ = self.owner.cancel.cancelled() => Err(Error::Closed), result = self.source.session.dispatch(method.clone(), params.to_string()) => result };
        if matches!(
            result,
            Err(Error::InvalidMessage | Error::Overflow | Error::Closed)
        ) && let Some(guard) = &mut guard
        {
            guard.armed = false;
            self.source
                .resources
                .lock()
                .map_err(|_| Error::Closed)?
                .remove(&guard.wire);
        }
        if result.is_ok()
            && let Some(guard) = &mut guard
        {
            guard.armed = false;
            if method == "unsubscribe" || method == "uploadCancel" {
                self.source
                    .resources
                    .lock()
                    .map_err(|_| Error::Closed)?
                    .remove(&guard.wire);
            }
        }
        result
    }
    pub async fn fetch_response(&self, params: String) -> Result<Arc<crate::NativeResponseStream>> {
        self.open()?;
        self.source
            .session
            .fetch_response_owned(params, self.owner.cancel.clone())
            .await
    }
    pub async fn upload_chunk(&self, mut payload: Vec<u8>) -> Result<()> {
        self.open()?;
        check(payload.len() >= 24 && payload.len() <= 65536 + 24)?;
        let local = Uuid::from_slice(&payload[..16])
            .map_err(|_| Error::InvalidMessage)?
            .to_string();
        let wire = self.source.resource(&self.owner.id, &local, Kind::Upload)?;
        payload[..16].copy_from_slice(
            Uuid::parse_str(&wire)
                .map_err(|_| Error::InvalidMessage)?
                .as_bytes(),
        );
        tokio::select! { _ = self.owner.cancel.cancelled() => Err(Error::Closed), result = self.source.session.upload_chunk(payload) => result }
    }
    pub async fn next_event(&self) -> Result<String> {
        let _reader = self.reader.lock().await;
        loop {
            let wake = self.owner.wake.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            let ended = self.owner.cancel.is_cancelled() || self.source.cancel.is_cancelled();
            if let Some(event) = self
                .owner
                .events
                .lock()
                .map_err(|_| Error::Closed)?
                .pop_front()
            {
                return Ok(event.text.clone());
            }
            if ended {
                return Err(if self.owner.overflow.load(Ordering::Acquire) {
                    Error::Overflow
                } else {
                    Error::Closed
                });
            }
            tokio::select! { _ = self.owner.cancel.cancelled() => {}, _ = self.source.cancel.cancelled() => {}, _ = wake => {} }
        }
    }
}
impl NativeSourceLease {
    fn open(&self) -> Result<()> {
        if self.owner.cancel.is_cancelled() || self.source.cancel.is_cancelled() {
            Err(Error::Closed)
        } else {
            Ok(())
        }
    }
}

struct Slot {
    source: tokio::sync::Mutex<Weak<Source>>,
    credential_gate: Arc<tokio::sync::Mutex<()>>,
    cancel: CancellationToken,
}
#[derive(uniffi::Object)]
pub struct NativeRuntime {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    cancel: CancellationToken,
}
impl Drop for NativeRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[uniffi::export(async_runtime = "tokio")]
impl NativeRuntime {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            slots: Mutex::new(HashMap::new()),
            cancel: CancellationToken::new(),
        })
    }
    pub fn shutdown(&self) {
        self.cancel.cancel();
        if let Ok(mut slots) = self.slots.lock() {
            for (_, slot) in slots.drain() {
                slot.cancel.cancel();
                if let Ok(source) = slot.source.try_lock()
                    && let Some(source) = source.upgrade()
                {
                    source.shutdown();
                }
            }
        }
    }
    pub fn retire_profile(&self, profile_id: String) {
        if let Ok(slots) = self.slots.lock()
            && let Some(slot) = slots.get(&profile_id)
        {
            slot.cancel.cancel();
            if let Ok(source) = slot.source.try_lock()
                && let Some(source) = source.upgrade()
            {
                source.shutdown();
            }
        }
    }
    /// Wait for an old actor's cancellation restore before reading native storage.
    pub async fn settle_credential(&self, profile_id: String) -> Result<()> {
        let slot = self.slot(&profile_id)?;
        tokio::select! {
            biased;
            _ = slot.cancel.cancelled() => Err(Error::Closed),
            guard = slot.credential_gate.lock() => { drop(guard); Ok(()) }
        }
    }
    pub async fn login(
        &self,
        profile_id: String,
        route: NativeRoute,
        username: String,
        password: String,
        storage: Arc<dyn CredentialPersistence>,
    ) -> Result<Arc<NativeSourceLease>> {
        let password = zeroize::Zeroizing::new(password);
        crate::session::validate_routes(std::slice::from_ref(&route), &username)?;
        let slot = self.slot(&profile_id)?;
        let mut held = slot.source.lock().await;
        if held
            .upgrade()
            .is_some_and(|source| !source.cancel.is_cancelled())
        {
            return Err(Error::Unavailable);
        }
        let options = SessionOptions {
            endpoint: route.endpoint,
            relay_target: route.relay_target,
            username,
        };
        let session = tokio::select! { _ = slot.cancel.cancelled() => return Err(Error::Closed), result = crate::session::login_gated(options, password, Some(storage), slot.credential_gate.clone()) => result? };
        let source = Source::start(session, route.route_id, slot.cancel.child_token());
        let lease = source.lease()?;
        *held = Arc::downgrade(&source);
        Ok(lease)
    }
    pub async fn acquire(
        &self,
        profile_id: String,
        routes: Vec<NativeRoute>,
        username: String,
        credential: Vec<u8>,
        storage: Arc<dyn CredentialPersistence>,
    ) -> Result<Arc<NativeSourceLease>> {
        self.acquire_foreground(profile_id, routes, username, credential, storage, false)
            .await
    }
    /// A visible foreground's signal may request the quick cycle. A scheduled
    /// backstop requests one attempt, respecting the relay admission budget.
    pub async fn acquire_foreground(
        &self,
        profile_id: String,
        routes: Vec<NativeRoute>,
        username: String,
        credential: Vec<u8>,
        storage: Arc<dyn CredentialPersistence>,
        quick_retries: bool,
    ) -> Result<Arc<NativeSourceLease>> {
        check(
            credential.len() <= 4096
                && !routes.is_empty()
                && routes.len() <= 16
                && (3..=128).contains(&username.len()),
        )?;
        let credential = zeroize::Zeroizing::new(credential);
        crate::session::validate_routes(&routes, &username)?;
        let slot = self.slot(&profile_id)?;
        let mut held = slot.source.lock().await;
        if let Some(source) = held.upgrade().filter(|source| {
            !source.cancel.is_cancelled() && source.session.credential_data().is_ok()
        }) {
            let existing = zeroize::Zeroizing::new(source.session.credential_data()?);
            let existing: Value = serde_json::from_slice(&existing)?;
            let supplied: Value = serde_json::from_slice(&credential)?;
            check(
                existing["username"] == username
                    && supplied["username"] == username
                    && existing["session_id"] == supplied["session_id"]
                    && existing["base_key"] == supplied["base_key"],
            )?;
            return source.lease();
        }
        let session = tokio::select! { _ = slot.cancel.cancelled() => return Err(Error::Closed), result = crate::session::resume_routes_gated(routes, username, &credential, storage, slot.credential_gate.clone(), quick_retries) => result? };
        let source = Source::start(session, String::new(), slot.cancel.child_token());
        let lease = source.lease()?;
        *held = Arc::downgrade(&source);
        Ok(lease)
    }
}
impl NativeRuntime {
    fn slot(&self, id: &str) -> Result<Arc<Slot>> {
        check(!id.is_empty() && id.len() <= 128)?;
        if self.cancel.is_cancelled() {
            return Err(Error::Closed);
        }
        let mut slots = self.slots.lock().map_err(|_| Error::Closed)?;
        slots.retain(|_, slot| {
            Arc::strong_count(slot) > 1
                || Arc::strong_count(&slot.credential_gate) > 1
                || slot.source.try_lock().map_or(true, |source| {
                    source
                        .upgrade()
                        .is_some_and(|source| !source.cancel.is_cancelled())
                })
        });
        if !slots.contains_key(id) && slots.len() >= 64 {
            return Err(Error::Overflow);
        }
        if let Some(old) = slots.get(id).filter(|slot| slot.cancel.is_cancelled()) {
            let next = Arc::new(Slot {
                source: tokio::sync::Mutex::new(Weak::new()),
                credential_gate: old.credential_gate.clone(),
                cancel: self.cancel.child_token(),
            });
            slots.insert(id.into(), next);
        }
        Ok(slots
            .entry(id.into())
            .or_insert_with(|| {
                Arc::new(Slot {
                    source: tokio::sync::Mutex::new(Weak::new()),
                    credential_gate: Arc::new(tokio::sync::Mutex::new(())),
                    cancel: self.cancel.child_token(),
                })
            })
            .clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        self,
        tests::{fixture_credential_data, peer},
    };
    async fn source() -> (Arc<Source>, tokio::task::JoinHandle<()>) {
        let (options, peer) = peer(3, "").await;
        let session = session::resume(options, &fixture_credential_data(), None)
            .await
            .unwrap();
        (
            Source::start(session, "fixture".into(), CancellationToken::new()),
            peer,
        )
    }
    #[tokio::test]
    async fn owners_scope_identical_subscription_ids_and_cancellation() {
        let (source, peer) = source().await;
        let alpha = source.lease().unwrap();
        let beta = source.lease().unwrap();
        let params = r#"{"subscriptionId":"same","channel":"activity"}"#;
        for lease in [&alpha, &beta] {
            lease
                .dispatch("subscribe".into(), params.into())
                .await
                .unwrap();
            let event =
                tokio::time::timeout(std::time::Duration::from_millis(500), lease.next_event())
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(parse(&event, 4096).unwrap()["subscriptionId"], "same");
        }
        assert_eq!(source.resources.lock().unwrap().len(), 2);
        let held = alpha.clone();
        let request = tokio::spawn(async move {
            held.dispatch(
                "request".into(),
                r#"{"method":"GET","path":"/held"}"#.into(),
            )
            .await
        });
        tokio::task::yield_now().await;
        alpha.release();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), request)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_eq!(source.resources.lock().unwrap().len(), 1);
        assert!(
            beta.dispatch(
                "request".into(),
                r#"{"method":"GET","path":"/healthy"}"#.into()
            )
            .await
            .unwrap()
            .contains("200")
        );
        beta.release();
        tokio::time::timeout(std::time::Duration::from_millis(500), peer)
            .await
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn aggregate_pressure_retires_largest_lagging_owner_not_producer() {
        let (source, peer) = source().await;
        let alpha = source.lease().unwrap();
        let beta = source.lease().unwrap();
        let healthy = source.lease().unwrap();
        let budget = Arc::new(AtomicUsize::new(0));
        for lease in [&alpha, &beta] {
            source.deliver(
                &lease.owner,
                json!({"type":"event","data":"a".repeat(23 * 1024 * 1024)}),
                &budget,
            );
        }
        source.deliver(
            &healthy.owner,
            json!({"type":"event","data":"a".repeat(20 * 1024 * 1024)}),
            &budget,
        );
        assert!(healthy.open().is_ok());
        assert!(alpha.open().is_err() || beta.open().is_err());
        assert!(budget.load(Ordering::Acquire) <= QUEUE_BYTES);
        alpha.release();
        beta.release();
        healthy.release();
        assert_eq!(budget.load(Ordering::Acquire), 0);
        peer.await.unwrap();
    }
    #[tokio::test]
    async fn explicit_retirement_discards_data_and_fatal_retirement_keeps_only_terminal_state() {
        for fatal in [false, true] {
            let (source, peer) = source().await;
            let owner = source.lease().unwrap();
            let budget = Arc::new(AtomicUsize::new(0));
            source.deliver(
                &owner.owner,
                json!({"type":"event","data":"retired"}),
                &budget,
            );
            source.deliver(
                &owner.owner,
                json!({"type":"state","phase":"FAILED"}),
                &budget,
            );
            source.stop(fatal);
            if fatal {
                assert!(owner.next_event().await.unwrap().contains("FAILED"));
            }
            assert!(matches!(owner.next_event().await, Err(Error::Closed)));
            assert_eq!(budget.load(Ordering::Acquire), 0);
            peer.await.unwrap();
        }
    }
    #[test]
    fn concurrent_profile_lookup_retains_uninitialized_slot_and_shutdown_cancels_it() {
        let runtime = NativeRuntime::new();
        let pending = runtime.slot("pending").unwrap();
        let _other = runtime.slot("other").unwrap();
        assert!(Arc::ptr_eq(&pending, &runtime.slot("pending").unwrap()));
        runtime.retire_profile("pending".into());
        assert!(pending.cancel.is_cancelled());
        let next = runtime.slot("pending").unwrap();
        assert!(!Arc::ptr_eq(&pending, &next));
        runtime.shutdown();
        assert!(next.cancel.is_cancelled());
        assert!(runtime.slot("next").is_err());
    }
}

#[cfg(test)]
mod credential_race_tests {
    use super::*;
    use crate::session::tests::{fixture_credential_data, peer};
    use std::sync::{Condvar, atomic::AtomicUsize};
    use tokio::time::{Duration, timeout};
    struct Storage {
        saved: Mutex<Option<Vec<u8>>>,
        begins: AtomicUsize,
        events: tokio::sync::mpsc::UnboundedSender<&'static str>,
        gate: (Mutex<bool>, Condvar),
        log: Mutex<Vec<String>>,
    }
    impl Storage {
        fn release(&self) {
            *self.gate.0.lock().unwrap() = true;
            self.gate.1.notify_all();
        }
    }
    struct Release(Arc<Storage>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.release();
        }
    }
    impl CredentialPersistence for Storage {
        fn begin_resume(&self) -> bool {
            *self.saved.lock().unwrap() = None;
            self.log.lock().unwrap().push("begin".into());
            if self.begins.fetch_add(1, Ordering::AcqRel) == 1 {
                self.events.send("reconnecting").unwrap();
            }
            true
        }
        fn persist(&self, value: Vec<u8>) -> bool {
            let version =
                serde_json::from_slice::<Value>(&value).unwrap()["resume_protocol_version"]
                    .as_u64()
                    .unwrap();
            if self.begins.load(Ordering::Acquire) == 2 && version == 3 {
                self.events.send("restoring").unwrap();
                let mut open = self.gate.0.lock().unwrap();
                while !*open {
                    open = self.gate.1.wait(open).unwrap();
                }
            }
            self.log.lock().unwrap().push(format!("persist:{version}"));
            *self.saved.lock().unwrap() = Some(value);
            true
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_actor_credential_restoration_precedes_snapshot_and_new_proof() {
        for retire in [false, true] {
            let (events, mut observed) = tokio::sync::mpsc::unbounded_channel();
            let storage = Arc::new(Storage {
                saved: Mutex::new(Some(fixture_credential_data())),
                begins: AtomicUsize::new(0),
                events,
                gate: (Mutex::new(false), Condvar::new()),
                log: Mutex::new(Vec::new()),
            });
            let _release = Release(storage.clone());
            let runtime = NativeRuntime::new();
            let (first, first_peer) = peer(3, "reconnect-stall").await;
            let route = |endpoint| NativeRoute {
                route_id: "direct".into(),
                endpoint,
                relay_target: None,
            };
            let lease = runtime
                .acquire(
                    "profile".into(),
                    vec![route(first.endpoint)],
                    first.username.clone(),
                    fixture_credential_data(),
                    storage.clone(),
                )
                .await
                .unwrap();
            assert!(
                lease
                    .dispatch(
                        "request".into(),
                        json!({"method":"GET","path":"/drop-for-resume"}).to_string()
                    )
                    .await
                    .is_err()
            );
            assert_eq!(
                timeout(Duration::from_secs(3), observed.recv())
                    .await
                    .unwrap(),
                Some("reconnecting")
            );
            assert!(storage.saved.lock().unwrap().is_none());
            lease.release();
            assert_eq!(
                timeout(Duration::from_secs(3), observed.recv())
                    .await
                    .unwrap(),
                Some("restoring")
            );
            if retire {
                runtime.retire_profile("profile".into());
            }
            let _other = runtime.slot("other").unwrap();
            let settle = runtime.settle_credential("profile".into());
            tokio::pin!(settle);
            assert!(
                futures_util::poll!(&mut settle).is_pending(),
                "snapshot must wait for old restoration"
            );
            let (next, next_peer) = peer(5, "").await;
            let acquire = runtime.acquire(
                "profile".into(),
                vec![route(next.endpoint)],
                first.username,
                fixture_credential_data(),
                storage.clone(),
            );
            tokio::pin!(acquire);
            assert!(
                futures_util::poll!(&mut acquire).is_pending(),
                "new proof must wait for old restoration"
            );
            storage.release();
            timeout(Duration::from_secs(3), settle)
                .await
                .unwrap()
                .unwrap();
            assert!(storage.saved.lock().unwrap().is_some());
            let new = timeout(Duration::from_secs(3), acquire)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(storage.saved.lock().unwrap().as_ref().unwrap())
                    .unwrap()["resume_protocol_version"],
                5
            );
            assert_eq!(
                &*storage.log.lock().unwrap(),
                &[
                    "begin",
                    "persist:3",
                    "begin",
                    "persist:3",
                    "begin",
                    "persist:5"
                ]
            );
            new.release();
            runtime.shutdown();
            first_peer.abort();
            next_peer.abort();
        }
    }
}
