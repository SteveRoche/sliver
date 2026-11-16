//! Pairing (ALPN `sliver/pair/1`): the device that has the vault shows a
//! ticket (its address, the vault's id and a one-time token, valid for a few
//! minutes while the pairing dialog is open); the other device dials it with
//! the token, and each adds the other to the vault's devices. Only paired
//! devices may sync.

use std::path::Path;
use std::sync::Weak;
use std::time::{Duration, Instant};

use data_encoding::BASE32_NOPAD;
use iroh::endpoint::{Connection, presets};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use sliver_vault::Uuid;
use sliver_vault::sync::{SyncConfig, SyncPeer, prepare_join, save_sync_config, sync_config};
use tauri::AppHandle;

use super::device;
use super::protocol::{Res, err, now_ms, read_msg, write_msg};
use super::service::{self, Service, add_peer, emit_status, open_root, with_open_vault};

pub const PAIR_ALPN: &[u8] = b"sliver/pair/1";

const TICKET_PREFIX: &str = "sliver";
const TICKET_TTL: Duration = Duration::from_secs(5 * 60);
const ONLINE_TIMEOUT: Duration = Duration::from_secs(10);
const JOIN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_NAME: usize = 100;

pub struct Pairing {
    pub token: Uuid,
    pub ticket: String,
    pub expires: Instant,
}

#[derive(Serialize, Deserialize)]
struct Ticket {
    addr: EndpointAddr,
    vault: Uuid,
    token: Uuid,
}

#[derive(Serialize, Deserialize)]
struct PairRequest {
    token: Uuid,
    name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PairReply {
    Accepted { vault: Uuid, name: String },
    Refused { reason: String },
}

fn encode(ticket: &Ticket) -> String {
    let json = serde_json::to_vec(ticket).expect("serializable");
    format!(
        "{TICKET_PREFIX}{}",
        BASE32_NOPAD.encode(&json).to_ascii_lowercase()
    )
}

fn decode(text: &str) -> Res<Ticket> {
    let text: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let invalid = || "that isn't a pairing ticket from Sliver".to_owned();
    let body = text.strip_prefix(TICKET_PREFIX).ok_or_else(invalid)?;
    let json = BASE32_NOPAD
        .decode(body.to_ascii_uppercase().as_bytes())
        .map_err(|_| invalid())?;
    serde_json::from_slice(&json).map_err(|_| invalid())
}

fn clean_name(name: &str) -> String {
    let name: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME)
        .collect();
    if name.is_empty() {
        "Unnamed device".into()
    } else {
        name
    }
}

/// Starts pairing with the open vault (setting it up for sync if needed) and
/// returns the ticket.
pub async fn start(app: &AppHandle) -> Res<String> {
    let root = open_root(app)?;
    let config = with_open_vault(app, &root, |vault| {
        let root = vault.root();
        match sync_config(root).map_err(err)? {
            Some(config) => Ok(config),
            None => {
                let config = SyncConfig {
                    vault: Uuid::new_v4(),
                    peers: Vec::new(),
                    joining: false,
                };
                save_sync_config(root, &config).map_err(err)?;
                Ok(config)
            }
        }
    })
    .await?;
    let service = service::ensure_running(app, &root).await?;
    // With a relay the ticket works across networks; without one (offline)
    // it still has the local addresses.
    let _ = tokio::time::timeout(ONLINE_TIMEOUT, service.endpoint.online()).await;
    let token = Uuid::new_v4();
    let ticket = encode(&Ticket {
        addr: service.endpoint.addr(),
        vault: config.vault,
        token,
    });
    *service
        .pairing
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Pairing {
        token,
        ticket: ticket.clone(),
        expires: Instant::now() + TICKET_TTL,
    });
    emit_status(app);
    Ok(ticket)
}

pub fn cancel(app: &AppHandle) {
    if let Some(service) = service::current(app) {
        service
            .pairing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        service::stop_if_idle(&app).await;
        emit_status(&app);
    });
}

/// Pairs with the device that showed `ticket`, then sets up `folder` to
/// receive the vault.
pub async fn join(app: &AppHandle, ticket: &str, folder: &Path) -> Res<()> {
    let ticket = decode(ticket)?;
    if folder.exists() && std::fs::read_dir(folder).map_err(err)?.next().is_some() {
        return Err("choose an empty folder for the vault".into());
    }
    // This device's key mustn't be bound by two endpoints at once.
    service::stop(app).await;
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(device::secret_key(app)?)
        .bind()
        .await
        .map_err(err)?;
    let reply = tokio::time::timeout(JOIN_TIMEOUT, async {
        let conn = endpoint
            .connect(ticket.addr.clone(), PAIR_ALPN)
            .await
            .map_err(err)?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(err)?;
        let request = PairRequest {
            token: ticket.token,
            name: device::name(app),
        };
        write_msg(&mut send, &request).await?;
        let reply: PairReply = read_msg(&mut recv).await?;
        let _ = send.finish();
        conn.close(0u32.into(), b"paired");
        Ok::<_, String>(reply)
    })
    .await
    .map_err(|_| "the other device didn't answer; is its pairing dialog still open?".to_owned());
    endpoint.close().await;
    match reply?? {
        PairReply::Accepted { vault, name } if vault == ticket.vault => prepare_join(
            folder,
            &SyncConfig {
                vault,
                peers: vec![SyncPeer {
                    id: ticket.addr.id.to_string(),
                    name: clean_name(&name),
                    paired_at: now_ms(),
                    last_sync: None,
                }],
                joining: true,
            },
        )
        .map_err(err),
        PairReply::Accepted { .. } => Err("the other device answered for another vault".into()),
        PairReply::Refused { reason } => Err(reason),
    }
}

#[derive(Clone)]
pub struct PairHandler(pub Weak<Service>);

impl std::fmt::Debug for PairHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairHandler")
    }
}

impl ProtocolHandler for PairHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        if let Some(service) = self.0.upgrade()
            && let Err(e) = accept_pairing(&service, connection).await
        {
            eprintln!("pairing: {e}");
        }
        Ok(())
    }
}

async fn accept_pairing(service: &Service, conn: Connection) -> Res<()> {
    let (mut send, mut recv) = conn.accept_bi().await.map_err(err)?;
    let request: PairRequest = read_msg(&mut recv).await?;
    let valid = {
        let mut pairing = service
            .pairing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let valid = pairing
            .as_ref()
            .is_some_and(|p| p.token == request.token && p.expires > Instant::now());
        if valid {
            // A ticket pairs one device.
            pairing.take();
        }
        valid
    };
    let reply = if valid {
        let id = conn.remote_id().to_string();
        let name = clean_name(&request.name);
        let added = name.clone();
        let root = service.root.clone();
        let vault = service
            .with_vault(move |_| {
                let mut config = sync_config(&root)
                    .map_err(err)?
                    .ok_or("this vault isn't set up for sync")?;
                add_peer(&root, &mut config, id, added)?;
                Ok(config.vault)
            })
            .await;
        match vault {
            Ok(vault) => {
                service.emit("sync-paired", name);
                PairReply::Accepted {
                    vault,
                    name: service.name(),
                }
            }
            Err(reason) => PairReply::Refused { reason },
        }
    } else {
        PairReply::Refused {
            reason: "this ticket is no longer valid; show a new one on the other device".into(),
        }
    };
    let accepted = matches!(reply, PairReply::Accepted { .. });
    write_msg(&mut send, &reply).await?;
    let _ = send.finish();
    conn.closed().await;
    service.emit_status();
    if accepted {
        service.notify_changed();
    }
    Ok(())
}
