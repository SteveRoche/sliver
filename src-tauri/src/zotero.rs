//! Zotero, through the Better BibTeX add-on's local endpoints on Zotero's
//! port: the citation picker (`cayw`, the same search bar word processors
//! use) and JSON-RPC for exporting entries by citation key. Every call is
//! blocking; run them off the async runtime.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ureq::Agent;

const BASE: &str = "http://127.0.0.1:23119/better-bibtex";
const TRANSLATOR: &str = "Better BibLaTeX";

#[derive(Debug)]
pub enum ZoteroError {
    /// Zotero isn't running, or Better BibTeX isn't installed.
    Unavailable,
    Failed(String),
}

impl std::fmt::Display for ZoteroError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => write!(
                f,
                "Zotero isn't running, or the Better BibTeX add-on isn't installed"
            ),
            Self::Failed(message) => write!(f, "Zotero: {message}"),
        }
    }
}

type Result<T> = std::result::Result<T, ZoteroError>;

fn agent(timeout: Option<Duration>) -> Agent {
    Agent::config_builder()
        .timeout_global(timeout)
        .http_status_as_error(false)
        .build()
        .into()
}

fn get(agent: &Agent, url: &str) -> Result<String> {
    let mut response = agent
        .get(url)
        .call()
        .map_err(|_| ZoteroError::Unavailable)?;
    if !response.status().is_success() {
        return Err(ZoteroError::Unavailable);
    }
    response
        .body_mut()
        .read_to_string()
        .map_err(|e| ZoteroError::Failed(e.to_string()))
}

/// Whether the picker can be opened: Zotero runs with Better BibTeX loaded.
pub fn ready() -> bool {
    get(
        &agent(Some(Duration::from_secs(2))),
        &format!("{BASE}/cayw?probe=yes"),
    )
    .is_ok_and(|body| body.trim() == "ready")
}

/// A citation chosen in the picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub citation_key: String,
    /// E.g. `7` with label `page`.
    #[serde(default)]
    pub locator: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub suppress_author: bool,
}

/// Opens Zotero's citation picker and waits until the user picks (or
/// cancels, which gives none).
pub fn pick() -> Result<Vec<Pick>> {
    if !ready() {
        return Err(ZoteroError::Unavailable);
    }
    let body = get(&agent(None), &format!("{BASE}/cayw?format=json&minimize=1"))?;
    if body.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&body).map_err(|e| ZoteroError::Failed(e.to_string()))
}

fn rpc(agent: &Agent, method: &str, params: Value) -> Result<Value> {
    let mut response = agent
        .post(&format!("{BASE}/json-rpc"))
        .send_json(json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": 1 }))
        .map_err(|_| ZoteroError::Unavailable)?;
    let reply: Value = response
        .body_mut()
        .read_json()
        .map_err(|_| ZoteroError::Unavailable)?;
    if let Some(error) = reply.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(ZoteroError::Failed(message.to_owned()));
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

/// BibLaTeX entries for `keys`. Keys Zotero doesn't know are left out:
/// Better BibTeX fails a whole export over one unknown key, so each one it
/// names is dropped and the rest exported again.
pub fn export(keys: &[String]) -> Result<String> {
    let agent = agent(Some(Duration::from_secs(30)));
    let mut keys = keys.to_vec();
    while !keys.is_empty() {
        match rpc(&agent, "item.export", json!([keys, TRANSLATOR])) {
            Ok(result) => return Ok(result.as_str().unwrap_or_default().to_owned()),
            Err(ZoteroError::Failed(message)) => {
                let Some(missing) = message.strip_prefix("not found: ") else {
                    return Err(ZoteroError::Failed(message));
                };
                let before = keys.len();
                keys.retain(|k| k != missing.trim());
                if keys.len() == before {
                    return Err(ZoteroError::Failed(message));
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(String::new())
}

/// An item found by [`search`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub citation_key: String,
    pub title: String,
    /// E.g. `Bellotti et al. 2004`.
    pub byline: String,
}

/// Searching as you type is capped: the menu shows a handful anyway.
const SEARCH_LIMIT: usize = 30;

/// Items matching `query` in Zotero's quick search (title, creators, year),
/// with their citation keys. None when Zotero can't be reached.
pub fn search(query: &str) -> Vec<Found> {
    let agent = agent(Some(Duration::from_secs(2)));
    let Ok(result) = rpc(&agent, "item.search", json!([query])) else {
        return Vec::new();
    };
    result
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(found)
        .take(SEARCH_LIMIT)
        .collect()
}

/// A search result from a CSL-JSON item.
fn found(item: &Value) -> Option<Found> {
    let text = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or_default();
    let citation_key = text("citation-key");
    if citation_key.is_empty() {
        return None;
    }
    let authors: Vec<&str> = item
        .get("author")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| a.get("family").or_else(|| a.get("literal"))?.as_str())
        .collect();
    let author = match authors.as_slice() {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [one, two] => format!("{one} & {two}"),
        [one, ..] => format!("{one} et al."),
    };
    let year = item
        .pointer("/issued/date-parts/0/0")
        .map(|y| y.as_str().map_or_else(|| y.to_string(), str::to_owned))
        .unwrap_or_default();
    Some(Found {
        citation_key: citation_key.to_owned(),
        title: text("title").to_owned(),
        byline: [author, year]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
    })
}

/// The link that selects the item with citation key `key` in Zotero. Zotero
/// selects by item key, so the item is looked up first; without Zotero
/// running, the link just starts it.
pub fn select_url(key: &str) -> String {
    let agent = agent(Some(Duration::from_secs(5)));
    let found = rpc(&agent, "item.search", json!([[["citationKey", "is", key]]]))
        .ok()
        .and_then(|result| {
            result
                .as_array()?
                .iter()
                .find(|item| item.get("citation-key").and_then(Value::as_str) == Some(key))?
                .get("id")?
                .as_str()
                .and_then(item_url)
        });
    found.unwrap_or_else(|| "zotero://select/library/items".to_owned())
}

/// `zotero://select/...` for an item's URI, e.g.
/// `http://zotero.org/users/123/items/ABCD1234` or `.../groups/456/items/...`.
fn item_url(uri: &str) -> Option<String> {
    let (library, item) = uri.split_once("/items/")?;
    if item.is_empty() || !item.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let group = library
        .split_once("/groups/")
        .map(|(_, id)| id)
        .filter(|id| id.chars().all(|c| c.is_ascii_digit()));
    Some(match group {
        Some(id) => format!("zotero://select/groups/{id}/items/{item}"),
        None => format!("zotero://select/library/items/{item}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_picks_and_item_links() {
        let picks: Vec<Pick> = serde_json::from_str(
            r#"[{"id": 1, "citationKey": "doe2020", "locator": "7", "label": "page", "prefix": "", "suffix": "", "suppressAuthor": true, "item": {}},
                {"citationKey": "roe2021"}]"#,
        )
        .unwrap();
        assert_eq!(picks[0].citation_key, "doe2020");
        assert!(picks[0].suppress_author);
        assert_eq!(picks[1].locator, "");
        assert_eq!(
            item_url("http://zotero.org/users/17918792/items/W4C64J95").as_deref(),
            Some("zotero://select/library/items/W4C64J95")
        );
        assert_eq!(
            item_url("http://zotero.org/groups/42/items/ABCD1234").as_deref(),
            Some("zotero://select/groups/42/items/ABCD1234")
        );
        assert_eq!(item_url("http://zotero.org/users/1"), None);
        let item = found(&json!({
            "citation-key": "bellotti2004",
            "title": "What a to-do",
            "author": [{"family": "Bellotti"}, {"family": "Dalal"}, {"family": "Good"}],
            "issued": {"date-parts": [["2004", 4, 25]]},
        }))
        .unwrap();
        assert_eq!(item.byline, "Bellotti et al. 2004");
        assert!(found(&json!({"title": "No key"})).is_none());
    }
}
