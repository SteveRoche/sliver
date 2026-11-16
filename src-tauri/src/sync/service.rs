//! The sync service of the open vault: an iroh endpoint (this device's key,
//! n0's relays and address lookup) with a router for the sync and pairing
//! protocols, and a loop that runs a round with every paired device after
//! local changes settle and every minute. It runs while a vault with paired
//! devices (or one being paired) is open.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use iroh::endpoint::{Connection, presets};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointId};
use sliver_vault::sync::{
    SyncConfig, SyncPeer, SyncedFiles, forget_peer, save_sync_config, sync_config,
};
use sliver_vault::{DiskChanges, Vault};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Notify, watch};
use tokio::task::JoinSet;

use super::pair::{PAIR_ALPN, PairHandler, Pairing};
use super::protocol::{self, Host, Res, RoundError, SYNC_ALPN, err, now_ms};
use super::{PeerStatus, SyncStatus, device};
use crate::commands::{OpenVault, lock};

/// How long local changes must settle before a round.
const SETTLE: Duration = Duration::from_secs(2);
/// How often to check with every device anyway.
const PERIOD: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_BACKOFF: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct SyncState {
    service: Mutex<Option<Arc<Service>>>,
    /// Serializes starting and stopping.
    lifecycle: tokio::sync::Mutex<()>,
}

pub struct Service {
    app: AppHandle,
    pub root: PathBuf,
    pub endpoint: Endpoint,
    router: Router,
    changed: Notify,
    stop: watch::Sender<bool>,
    /// One round at a time per device.
    rounds: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    peers: Mutex<HashMap<String, PeerRuntime>>,
    pub pairing: Mutex<Option<Pairing>>,
}

#[derive(Default)]
struct PeerRuntime {
    state: Option<&'static str>,
    error: Option<String>,
    failures: u32,
    retry_at: Option<Instant>,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn init(app: &AppHandle) {
    app.manage(SyncState::default());
}

pub fn current(app: &AppHandle) -> Option<Arc<Service>> {
    guard(&app.state::<SyncState>().service).clone()
}

/// The open vault's root.
pub fn open_root(app: &AppHandle) -> Res<PathBuf> {
    lock(&app.state::<OpenVault>())
        .as_ref()
        .map(|v| v.root().to_path_buf())
        .ok_or_else(|| "no vault is open".to_owned())
}

pub fn vault_opened(app: &AppHandle, root: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<SyncState>();
        let _lifecycle = state.lifecycle.lock().await;
        stop_current(&app).await;
        let paired = sync_config(&root)
            .ok()
            .flatten()
            .is_some_and(|c| !c.peers.is_empty());
        if paired && let Err(e) = start(&app, root).await {
            eprintln!("could not start sync: {e}");
        }
        emit_status(&app);
    });
}

/// The service for the vault at `root`, started if it isn't running.
pub async fn ensure_running(app: &AppHandle, root: &Path) -> Res<Arc<Service>> {
    let state = app.state::<SyncState>();
    let _lifecycle = state.lifecycle.lock().await;
    if let Some(service) = current(app).filter(|s| s.root == root) {
        return Ok(service);
    }
    stop_current(app).await;
    start(app, root.to_path_buf()).await
}

/// Stops the service, e.g. before another endpoint uses this device's key.
pub async fn stop(app: &AppHandle) {
    let state = app.state::<SyncState>();
    let _lifecycle = state.lifecycle.lock().await;
    stop_current(app).await;
    emit_status(app);
}

/// Stops the service if nothing needs it: no paired devices, no pairing.
pub async fn stop_if_idle(app: &AppHandle) {
    let Some(service) = current(app) else { return };
    let paired = sync_config(&service.root)
        .ok()
        .flatten()
        .is_some_and(|c| !c.peers.is_empty());
    if !paired && guard(&service.pairing).is_none() {
        stop(app).await;
    }
}

async fn stop_current(app: &AppHandle) {
    let service = guard(&app.state::<SyncState>().service).take();
    if let Some(service) = service {
        let _ = service.stop.send(true);
        let _ = service.router.shutdown().await;
    }
}

async fn start(app: &AppHandle, root: PathBuf) -> Res<Arc<Service>> {
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(device::secret_key(app)?)
        .bind()
        .await
        .map_err(err)?;
    let (stop, _) = watch::channel(false);
    let service = Arc::new_cyclic(|weak: &Weak<Service>| {
        let router = Router::builder(endpoint.clone())
            .accept(SYNC_ALPN, SyncHandler(weak.clone()))
            .accept(PAIR_ALPN, PairHandler(weak.clone()))
            .spawn();
        Service {
            app: app.clone(),
            root,
            endpoint,
            router,
            changed: Notify::new(),
            stop,
            rounds: Mutex::new(HashMap::new()),
            peers: Mutex::new(HashMap::new()),
            pairing: Mutex::new(None),
        }
    });
    *guard(&app.state::<SyncState>().service) = Some(service.clone());
    tauri::async_runtime::spawn(service.clone().run());
    Ok(service)
}

pub fn local_change(app: &AppHandle) {
    if let Some(service) = current(app) {
        service.changed.notify_one();
    }
}

pub async fn sync_now(app: &AppHandle) -> Res<()> {
    let service = current(app).ok_or("no devices are paired with this vault")?;
    service.sync_all(true).await;
    Ok(())
}

pub async fn remove_device(app: &AppHandle, id: &str) -> Res<()> {
    let root = open_root(app)?;
    let id = id.to_owned();
    let removed = id.clone();
    with_open_vault(app, &root, move |vault| {
        let root = vault.root();
        if let Some(mut config) = sync_config(root).map_err(err)? {
            config.peers.retain(|p| p.id != id);
            save_sync_config(root, &config).map_err(err)?;
        }
        forget_peer(root, &id).map_err(err)
    })
    .await?;
    if let Some(service) = current(app) {
        guard(&service.peers).remove(&removed);
    }
    stop_if_idle(app).await;
    emit_status(app);
    Ok(())
}

pub fn set_device_name(app: &AppHandle, name: &str) -> Res<()> {
    device::set_name(app, name)?;
    emit_status(app);
    Ok(())
}

pub fn status(app: &AppHandle) -> SyncStatus {
    let service = current(app);
    let root = service
        .as_ref()
        .map(|s| s.root.clone())
        .or_else(|| open_root(app).ok());
    let config = root.and_then(|root| sync_config(&root).ok().flatten());
    let runtime = service.as_ref().map(|s| guard(&s.peers));
    let peers = config
        .map(|c| c.peers)
        .unwrap_or_default()
        .into_iter()
        .map(|peer| {
            let run = runtime.as_ref().and_then(|r| r.get(&peer.id));
            PeerStatus {
                state: run.and_then(|r| r.state).unwrap_or("idle"),
                error: run.and_then(|r| r.error.clone()),
                id: peer.id,
                name: peer.name,
                last_sync: peer.last_sync,
            }
        })
        .collect();
    drop(runtime);
    SyncStatus {
        available: true,
        running: service.is_some(),
        device_name: device::name(app),
        device_id: service.as_ref().map(|s| s.endpoint.id().to_string()),
        peers,
        pairing: service.as_ref().and_then(|s| {
            guard(&s.pairing)
                .as_ref()
                .filter(|p| p.expires > Instant::now())
                .map(|p| p.ticket.clone())
        }),
    }
}

pub fn emit_status(app: &AppHandle) {
    let _ = app.emit("sync-status", status(app));
}

/// Runs `f` on the open vault, off the async runtime, if it's still the
/// vault at `root`.
pub async fn with_open_vault<T: Send + 'static>(
    app: &AppHandle,
    root: &Path,
    f: impl FnOnce(&mut Vault) -> Res<T> + Send + 'static,
) -> Res<T> {
    let app = app.clone();
    let root = root.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let open = app.state::<OpenVault>();
        let mut vault = lock(&open);
        let vault = vault
            .as_mut()
            .filter(|v| v.root() == root)
            .ok_or_else(|| "the vault was closed".to_owned())?;
        f(vault)
    })
    .await
    .map_err(err)?
}

impl Service {
    pub async fn with_vault<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Vault) -> Res<T> + Send + 'static,
    ) -> Res<T> {
        with_open_vault(&self.app, &self.root, f).await
    }

    pub fn name(&self) -> String {
        device::name(&self.app)
    }

    pub fn notify_changed(&self) {
        self.changed.notify_one();
    }

    pub fn emit_status(&self) {
        emit_status(&self.app);
    }

    pub fn emit(&self, event: &str, payload: impl serde::Serialize + Clone) {
        let _ = self.app.emit(event, payload);
    }

    fn round_lock(&self, peer: &str) -> Arc<tokio::sync::Mutex<()>> {
        guard(&self.rounds)
            .entry(peer.to_owned())
            .or_default()
            .clone()
    }

    fn set_peer(&self, peer: &str, state: &'static str, error: Option<String>) {
        let mut peers = guard(&self.peers);
        let run = peers.entry(peer.to_owned()).or_default();
        run.state = Some(state);
        run.error = error;
        match state {
            "idle" => {
                run.failures = 0;
                run.retry_at = None;
            }
            "offline" | "error" => {
                run.failures += 1;
                let backoff = Duration::from_secs(15)
                    .saturating_mul(1 << run.failures.min(5).saturating_sub(1))
                    .min(MAX_BACKOFF);
                run.retry_at = Some(Instant::now() + backoff);
            }
            _ => {}
        }
        drop(peers);
        emit_status(&self.app);
    }

    fn due(&self, peer: &str) -> bool {
        guard(&self.peers)
            .get(peer)
            .and_then(|r| r.retry_at)
            .is_none_or(|at| Instant::now() >= at)
    }

    async fn run(self: Arc<Self>) {
        let mut stop = self.stop.subscribe();
        loop {
            self.sync_all(false).await;
            tokio::select! {
                _ = self.changed.notified() => loop {
                    // Let a burst of changes (typing, a move) settle.
                    tokio::select! {
                        _ = self.changed.notified() => {}
                        _ = tokio::time::sleep(SETTLE) => break,
                        _ = stop.changed() => return,
                    }
                },
                _ = tokio::time::sleep(PERIOD) => {}
                _ = stop.changed() => return,
            }
            if *stop.borrow() {
                return;
            }
        }
    }

    /// A round with every paired device, at once; `force` ignores backoff.
    async fn sync_all(self: &Arc<Self>, force: bool) {
        let Ok(Some(config)) = sync_config(&self.root) else {
            return;
        };
        let mut rounds = JoinSet::new();
        for peer in config.peers {
            if force || self.due(&peer.id) {
                let service = self.clone();
                let config = (config.vault, config.joining);
                rounds.spawn(async move { service.round_with(peer, config).await });
            }
        }
        while rounds.join_next().await.is_some() {}
    }

    async fn round_with(
        self: Arc<Self>,
        peer: SyncPeer,
        (vault, joining): (sliver_vault::Uuid, bool),
    ) {
        let lock = self.round_lock(&peer.id);
        let Ok(_round) = lock.try_lock() else { return };
        self.set_peer(&peer.id, "syncing", None);
        match self.dial(&peer, vault, joining).await {
            Ok(()) => self.set_peer(&peer.id, "idle", None),
            Err(RoundError::Busy) => {
                // Both dialed at once: try again after a random pause.
                self.set_peer(&peer.id, "idle", None);
                let pause = 1000 + (sliver_vault::Uuid::new_v4().as_u128() % 3000) as u64;
                let service = self.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(pause)).await;
                    service.notify_changed();
                });
            }
            Err(RoundError::Offline(e)) => self.set_peer(&peer.id, "offline", Some(e)),
            Err(RoundError::Failed(e)) => {
                eprintln!("sync with {}: {e}", peer.name);
                self.set_peer(&peer.id, "error", Some(e));
            }
        }
    }

    /// A round as the dialing side, which decides it.
    async fn dial(
        &self,
        peer: &SyncPeer,
        vault: sliver_vault::Uuid,
        joining: bool,
    ) -> Result<(), RoundError> {
        let id: EndpointId = peer.id.parse().map_err(err)?;
        let conn = tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint.connect(id, SYNC_ALPN))
            .await
            .map_err(|_| RoundError::Offline("not reachable".into()))?
            .map_err(|e| RoundError::Offline(e.to_string()))?;
        protocol::dial(self, &conn, &peer.id, vault, joining).await
    }

    /// A round as the dialed side, from a paired device of this vault.
    async fn respond(&self, conn: Connection) -> Res<()> {
        let peer = conn.remote_id().to_string();
        let config = sync_config(&self.root)
            .map_err(err)?
            .ok_or("this vault isn't set up for sync")?;
        if !config.peers.iter().any(|p| p.id == peer) {
            conn.close(1u32.into(), b"not paired");
            return Err(format!("refused a device that isn't paired: {peer}"));
        }
        let lock = self.round_lock(&peer);
        let result = protocol::respond(self, &conn, &peer, config.vault, &lock, || {
            self.set_peer(&peer, "syncing", None)
        })
        .await;
        match &result {
            Ok(true) => self.set_peer(&peer, "idle", None),
            Ok(false) => {}
            Err(e) => self.set_peer(&peer, "error", Some(e.clone())),
        }
        result.map(|_| ())
    }
}

impl Host for Service {
    fn with_vault<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Vault) -> Res<T> + Send + 'static,
    ) -> impl Future<Output = Res<T>> + Send {
        with_open_vault(&self.app, &self.root, f)
    }

    fn device_name(&self) -> String {
        self.name()
    }

    /// Tells the frontend what a round changed here: the vault (as the file
    /// watcher would) and the files it doesn't cover.
    fn applied(&self, changes: DiskChanges, files: SyncedFiles) {
        if !changes.is_empty() {
            self.emit("vault-changed", changes);
        }
        if files.any() {
            self.emit("sync-applied", files);
        }
    }
}

/// Adds or replaces a device in the vault's sync setup.
pub fn add_peer(root: &Path, config: &mut SyncConfig, id: String, name: String) -> Res<()> {
    config.peers.retain(|p| p.id != id);
    config.peers.push(SyncPeer {
        id,
        name,
        paired_at: now_ms(),
        last_sync: None,
    });
    save_sync_config(root, config).map_err(err)
}

#[derive(Clone)]
pub struct SyncHandler(Weak<Service>);

impl std::fmt::Debug for SyncHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyncHandler")
    }
}

impl ProtocolHandler for SyncHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        if let Some(service) = self.0.upgrade()
            && let Err(e) = service.respond(connection).await
        {
            eprintln!("sync: {e}");
        }
        Ok(())
    }
}
