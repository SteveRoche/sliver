//! The sync protocol (ALPN `sliver/sync/1`): one bidirectional stream per
//! round. Frames are a big-endian `u64` length and that many bytes; messages
//! are JSON frames, and content follows its message as frames of their own
//! (a flag byte, 1 when present, then the bytes).
//!
//! ```text
//! dialing side (decides)             other side
//!   Hello { vault, name } -------->  checks it's a paired device of this vault
//!                         <--------  Manifest { name, entries }  (or Busy, Refused)
//!   Get { keys }          -------->
//!                         <--------  one content frame per key
//!   (applies its own ops)
//!   Put { ops, base, failed } + content frames for ops that need it -->
//!                         <--------  Done { failed }
//! ```
//!
//! Both sides then record `base` with `peer`, except keys whose ops failed on
//! either side.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use iroh::endpoint::{Connection, RecvStream, SendStream};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sliver_vault::sync::{
    EntryState, Manifest, Op, SyncedFiles, needed_bodies, plan, save_sync_config, sync_config,
};
use sliver_vault::{DeleteMode, DiskChanges, Uuid, Vault};

pub const SYNC_ALPN: &[u8] = b"sliver/sync/1";
pub const VERSION: u32 = 1;

const MAX_MESSAGE: u64 = 256 << 20;
const MAX_BODY: u64 = 2 << 30;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Msg {
    Hello {
        vault: Uuid,
        name: String,
        version: u32,
    },
    Manifest {
        name: String,
        entries: Manifest,
    },
    /// A round with this device is already running.
    Busy,
    Refused {
        reason: String,
    },
    Get {
        keys: Vec<String>,
    },
    Put {
        ops: Vec<Op>,
        base: BTreeMap<String, Option<EntryState>>,
        /// Keys whose ops failed on the dialing side.
        failed: BTreeSet<String>,
    },
    Done {
        failed: BTreeSet<String>,
    },
}

pub type Res<T> = Result<T, String>;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn write_frame(send: &mut SendStream, bytes: &[u8]) -> Res<()> {
    send.write_all(&(bytes.len() as u64).to_be_bytes())
        .await
        .map_err(err)?;
    send.write_all(bytes).await.map_err(err)
}

async fn read_frame(recv: &mut RecvStream, max: u64) -> Res<Vec<u8>> {
    let mut len = [0u8; 8];
    recv.read_exact(&mut len).await.map_err(err)?;
    let len = u64::from_be_bytes(len);
    if len > max {
        return Err(format!("a frame of {len} bytes is too large"));
    }
    let mut buf = vec![0u8; len as usize];
    recv.read_exact(&mut buf).await.map_err(err)?;
    Ok(buf)
}

pub async fn write_msg(send: &mut SendStream, msg: &impl Serialize) -> Res<()> {
    write_frame(send, &serde_json::to_vec(msg).map_err(err)?).await
}

pub async fn read_msg<T: DeserializeOwned>(recv: &mut RecvStream) -> Res<T> {
    let bytes = read_frame(recv, MAX_MESSAGE).await?;
    serde_json::from_slice(&bytes).map_err(|e| format!("unexpected message: {e}"))
}

pub async fn write_body(send: &mut SendStream, body: Option<&[u8]>) -> Res<()> {
    match body {
        Some(bytes) => {
            let mut frame = Vec::with_capacity(bytes.len() + 1);
            frame.push(1);
            frame.extend_from_slice(bytes);
            write_frame(send, &frame).await
        }
        None => write_frame(send, &[0]).await,
    }
}

pub async fn read_body(recv: &mut RecvStream) -> Res<Option<Vec<u8>>> {
    let mut frame = read_frame(recv, MAX_BODY + 1).await?;
    match frame.first() {
        Some(1) => {
            frame.remove(0);
            Ok(Some(frame))
        }
        Some(0) => Ok(None),
        _ => Err("malformed content frame".into()),
    }
}

/// The content of a round's ops, by hash: kept as base texts for merging.
pub fn texts_of<'a>(
    ops: impl IntoIterator<Item = &'a (Op, Option<Vec<u8>>)>,
) -> HashMap<String, Vec<u8>> {
    ops.into_iter()
        .filter(|(op, _)| op.key.starts_with("note:"))
        .filter_map(|(op, body)| Some((op.state.as_ref()?.hash.clone(), body.clone()?)))
        .collect()
}

/// What a round needs from the app: the open vault, this device's name, and
/// somewhere to report what it changed.
pub trait Host: Send + Sync {
    /// Runs `f` on the vault, off the async runtime.
    fn with_vault<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Vault) -> Res<T> + Send + 'static,
    ) -> impl Future<Output = Res<T>> + Send;
    fn device_name(&self) -> String;
    /// A round changed the vault here.
    fn applied(&self, changes: DiskChanges, files: SyncedFiles);
}

/// Why a round didn't happen.
#[derive(Debug)]
pub enum RoundError {
    /// The device couldn't be reached.
    Offline(String),
    /// It's in a round with this device already (both dialed at once).
    Busy,
    Failed(String),
}

impl From<String> for RoundError {
    fn from(e: String) -> Self {
        Self::Failed(e)
    }
}

fn synced_files(applied: &[String], failed: &BTreeSet<String>) -> SyncedFiles {
    SyncedFiles::of(
        applied
            .iter()
            .filter(|key| !failed.contains(*key))
            .map(String::as_str),
    )
}

/// A round as the dialing side, which decides it, over `conn` to `peer`.
/// `joining`: see `sliver_vault::sync::plan`.
pub async fn dial(
    host: &impl Host,
    conn: &Connection,
    peer: &str,
    vault: Uuid,
    joining: bool,
) -> Result<(), RoundError> {
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| RoundError::Offline(e.to_string()))?;
    let hello = Msg::Hello {
        vault,
        name: host.device_name(),
        version: VERSION,
    };
    write_msg(&mut send, &hello).await?;
    let (remote_name, remote) = match read_msg(&mut recv).await? {
        Msg::Manifest { name, entries } => (name, entries),
        Msg::Busy => return Err(RoundError::Busy),
        Msg::Refused { reason } => return Err(RoundError::Failed(reason)),
        _ => return Err(RoundError::Failed("unexpected reply".into())),
    };

    let peer_id = peer.to_owned();
    let remote_manifest = remote.clone();
    let (base, local, decisions, needed) = host
        .with_vault(move |vault| {
            let base = vault.sync_base(&peer_id).map_err(err)?;
            let local = vault.sync_manifest().map_err(err)?;
            let decisions = plan(&base, &local, &remote_manifest, joining);
            let needed = needed_bodies(&decisions, &local, &remote_manifest);
            Ok((base, local, decisions, needed))
        })
        .await?;
    write_msg(
        &mut send,
        &Msg::Get {
            keys: needed.clone(),
        },
    )
    .await?;
    let mut bodies = HashMap::new();
    for key in needed {
        if let Some(body) = read_body(&mut recv).await? {
            bodies.insert(key, body);
        }
    }

    let (round, texts, applied, local_failed, changes) = host
        .with_vault(move |vault| {
            let mut round =
                vault.sync_round(&decisions, &base, &local, &remote, &bodies, &remote_name);
            let ops = std::mem::take(&mut round.local);
            let texts = texts_of(ops.iter().chain(&round.remote));
            let applied: Vec<String> = ops.iter().map(|(op, _)| op.key.clone()).collect();
            let (failed, changes) = vault.apply_sync(ops, DeleteMode::Trash).map_err(err)?;
            Ok((round, texts, applied, failed, changes))
        })
        .await?;
    host.applied(changes, synced_files(&applied, &local_failed));

    let put = Msg::Put {
        ops: round.remote.iter().map(|(op, _)| op.clone()).collect(),
        base: round.base.clone(),
        failed: local_failed.clone(),
    };
    write_msg(&mut send, &put).await?;
    for (op, body) in &round.remote {
        if op.needs_body() {
            write_body(&mut send, body.as_deref()).await?;
        }
    }
    let Msg::Done {
        failed: remote_failed,
    } = read_msg(&mut recv).await?
    else {
        return Err(RoundError::Failed("unexpected reply".into()));
    };
    let _ = send.finish();
    conn.close(0u32.into(), b"done");

    let mut failed = local_failed;
    failed.extend(remote_failed);
    record(host, peer, round.base, failed, texts, true).await?;
    Ok(())
}

/// A round as the dialed side, which does as the dialing side decided.
/// `lock` keeps it to one round at a time with `peer`; `started` runs once
/// the round is under way. Returns whether a round happened (not when busy
/// or refused).
pub async fn respond(
    host: &impl Host,
    conn: &Connection,
    peer: &str,
    vault: Uuid,
    lock: &tokio::sync::Mutex<()>,
    started: impl FnOnce(),
) -> Res<bool> {
    let (mut send, mut recv) = conn.accept_bi().await.map_err(err)?;
    let Msg::Hello {
        vault: theirs,
        version,
        ..
    } = read_msg(&mut recv).await?
    else {
        return Err("expected a greeting".into());
    };
    let refusal = if version != VERSION {
        Some("the other device runs a different version of Sliver")
    } else if theirs != vault {
        Some("the other device has a different vault open")
    } else {
        None
    };
    let round = lock.try_lock();
    if refusal.is_some() || round.is_err() {
        let msg = match refusal {
            Some(reason) => Msg::Refused {
                reason: reason.into(),
            },
            None => Msg::Busy,
        };
        write_msg(&mut send, &msg).await?;
        let _ = send.finish();
        conn.closed().await;
        return Ok(false);
    }
    started();

    let local: Manifest = host
        .with_vault(|vault| vault.sync_manifest().map_err(err))
        .await?;
    let manifest = Msg::Manifest {
        name: host.device_name(),
        entries: local.clone(),
    };
    write_msg(&mut send, &manifest).await?;
    let Msg::Get { keys } = read_msg(&mut recv).await? else {
        return Err("expected a request".into());
    };
    let bodies = host
        .with_vault(move |vault| {
            Ok(keys
                .iter()
                .map(|key| vault.read_entry(key, &local))
                .collect::<Vec<_>>())
        })
        .await?;
    for body in &bodies {
        write_body(&mut send, body.as_deref()).await?;
    }
    drop(bodies);

    let Msg::Put {
        ops,
        base,
        failed: remote_failed,
    } = read_msg(&mut recv).await?
    else {
        return Err("expected changes".into());
    };
    let mut with_bodies = Vec::with_capacity(ops.len());
    for op in ops {
        let body = if op.needs_body() {
            read_body(&mut recv).await?
        } else {
            None
        };
        with_bodies.push((op, body));
    }
    let texts = texts_of(&with_bodies);
    let applied: Vec<String> = with_bodies.iter().map(|(op, _)| op.key.clone()).collect();
    let (local_failed, changes) = host
        .with_vault(move |vault| {
            vault
                .apply_sync(with_bodies, DeleteMode::Trash)
                .map_err(err)
        })
        .await?;
    host.applied(changes, synced_files(&applied, &local_failed));
    let done = Msg::Done {
        failed: local_failed.clone(),
    };
    write_msg(&mut send, &done).await?;
    let _ = send.finish();

    let mut failed = local_failed;
    failed.extend(remote_failed);
    record(host, peer, base, failed, texts, false).await?;
    conn.closed().await;
    Ok(true)
}

/// Records a finished round: the new base, and when it happened.
async fn record(
    host: &impl Host,
    peer: &str,
    base: BTreeMap<String, Option<EntryState>>,
    failed: BTreeSet<String>,
    texts: HashMap<String, Vec<u8>>,
    dialed: bool,
) -> Res<()> {
    let peer = peer.to_owned();
    host.with_vault(move |vault| {
        vault
            .record_sync_base(&peer, &base, &failed, &texts)
            .map_err(err)?;
        let root = vault.root();
        if let Some(mut config) = sync_config(root).map_err(err)? {
            if let Some(entry) = config.peers.iter_mut().find(|p| p.id == peer) {
                entry.last_sync = Some(now_ms());
            }
            if dialed {
                config.joining = false;
            }
            save_sync_config(root, &config).map_err(err)?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use iroh::endpoint::presets;
    use iroh::{Endpoint, EndpointAddr, RelayMode, TransportAddr};
    use sliver_vault::Placement;
    use sliver_vault::sync::{SyncConfig, prepare_join};

    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("sliver-sync-test-{}", Uuid::new_v4())))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct TestHost {
        vault: Arc<Mutex<Vault>>,
        name: &'static str,
    }

    impl Host for TestHost {
        fn with_vault<T: Send + 'static>(
            &self,
            f: impl FnOnce(&mut Vault) -> Res<T> + Send + 'static,
        ) -> impl Future<Output = Res<T>> + Send {
            let result = f(&mut self.vault.lock().unwrap());
            async move { result }
        }

        fn device_name(&self) -> String {
            self.name.to_owned()
        }

        fn applied(&self, _changes: DiskChanges, _files: SyncedFiles) {}
    }

    /// An endpoint reachable only on this machine: no relay, no lookup.
    async fn endpoint() -> (Endpoint, EndpointAddr) {
        let endpoint = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .unwrap();
        let port = endpoint
            .bound_sockets()
            .into_iter()
            .find(SocketAddr::is_ipv4)
            .unwrap()
            .port();
        let addr = EndpointAddr::from_parts(
            endpoint.id(),
            [TransportAddr::Ip(SocketAddr::from(([127, 0, 0, 1], port)))],
        );
        (endpoint, addr)
    }

    /// One round over a real connection, `a` dialing `b`.
    async fn round(a: &(TestHost, Endpoint), b: &(TestHost, Endpoint, EndpointAddr), vault: Uuid) {
        let (b_host, b_endpoint, b_addr) = b;
        let a_id = a.1.id().to_string();
        let responder = async {
            let conn = b_endpoint.accept().await.unwrap().await.unwrap();
            let lock = tokio::sync::Mutex::new(());
            respond(b_host, &conn, &a_id, vault, &lock, || {})
                .await
                .unwrap()
        };
        let dialer = async {
            let conn = a.1.connect(b_addr.clone(), SYNC_ALPN).await.unwrap();
            dial(&a.0, &conn, &b_endpoint.id().to_string(), vault, false)
                .await
                .unwrap();
        };
        let (happened, ()) = tokio::join!(responder, dialer);
        assert!(happened);
    }

    #[tokio::test]
    async fn syncs_over_a_connection() {
        let (da, db) = (TempDir::new(), TempDir::new());
        let vault = Uuid::new_v4();
        let mut first = Vault::create(&da.0).unwrap();
        let note = first
            .create_note(Some("Over the wire".into()), Placement::NewSequence)
            .unwrap();
        std::fs::write(da.0.join("image.png"), [0u8, 1, 2, 3]).unwrap();
        first.refresh().unwrap();
        let config = SyncConfig {
            vault,
            peers: vec![],
            joining: false,
        };
        prepare_join(&db.0, &config).unwrap();
        let second = Vault::open(&db.0).unwrap();

        let (a_endpoint, _) = endpoint().await;
        let (b_endpoint, b_addr) = endpoint().await;
        let a = (
            TestHost {
                vault: Arc::new(Mutex::new(first)),
                name: "A",
            },
            a_endpoint,
        );
        let b = (
            TestHost {
                vault: Arc::new(Mutex::new(second)),
                name: "B",
            },
            b_endpoint,
            b_addr,
        );
        round(&a, &b, vault).await;
        let manifest = |host: &TestHost| host.vault.lock().unwrap().sync_manifest().unwrap();
        assert_eq!(manifest(&a.0), manifest(&b.0));
        assert_eq!(
            std::fs::read(db.0.join("image.png")).unwrap(),
            [0u8, 1, 2, 3]
        );

        // An edit on b goes back to a in the next round, a still dialing.
        {
            let mut second = b.0.vault.lock().unwrap();
            let text = second.read_note(note.id).unwrap() + "\nFrom B.\n";
            second.write_note(note.id, &text).unwrap();
        }
        round(&a, &b, vault).await;
        assert!(
            a.0.vault
                .lock()
                .unwrap()
                .read_note(note.id)
                .unwrap()
                .ends_with("From B.\n")
        );
        assert_eq!(manifest(&a.0), manifest(&b.0));
    }
}
