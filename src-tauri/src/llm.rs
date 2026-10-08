//! OpenAI-kompatibel AI-leverantör (text → text), t.ex. Berget AI eller en egen server.
//!
//! Bara text skickas hit, aldrig ljud. API-nyckeln hämtas ur nyckelförvaringen
//! av anroparen och skickas som `Authorization: Bearer`; den loggas aldrig.

use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::time::{timeout, Duration};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// Max tid utan nya data under strömning (långa transkript kan ta tid att börja svara på).
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Var och med vilken nyckel en leverantör nås. Nyckeln visas aldrig i Debug.
#[derive(Clone)]
pub struct Endpoint {
    pub base_url: String,
    pub api_key: Option<String>,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Endpoint")
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<dold>"))
            .finish()
    }
}

impl Endpoint {
    pub fn new(base_url: &str, api_key: Option<String>) -> Result<Self, String> {
        Ok(Self {
            base_url: normalize_base_url(base_url)?,
            api_key: api_key.filter(|k| !k.trim().is_empty()),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path.trim_start_matches('/'))
    }

    fn authorize(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(key) => req.bearer_auth(key),
            None => req,
        }
    }
}

/// Trimma och ta bort avslutande snedstreck; kräv http(s).
pub fn normalize_base_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("Ange en server-URL.".into());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Server-URL:en måste börja med https:// (eller http:// för en lokal server).".into());
    }
    Ok(url.to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LlmModel {
    pub id: String,
    /// Kontextfönster i tokens, om servern uppger det.
    pub context_length: Option<u64>,
}

/// Tolka svaret från `GET /models`. Klarar OpenAI-formatet (`data: [{id}]`),
/// en ren lista och `models: [...]`; extra fält som kontextlängd plockas upp
/// om de finns men krävs inte.
pub fn parse_models(body: &Value) -> Vec<LlmModel> {
    let items = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(|v| v.as_array())
        .or_else(|| body.as_array());
    let mut models: Vec<LlmModel> = items
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m
                .as_str()
                .or_else(|| m.get("id").and_then(|v| v.as_str()))
                .or_else(|| m.get("name").and_then(|v| v.as_str()))?
                .trim()
                .to_string();
            if id.is_empty() {
                return None;
            }
            let context_length = ["context_length", "max_model_len", "context_window", "max_context_length"]
                .iter()
                .find_map(|k| m.get(*k).and_then(|v| v.as_u64()))
                .or_else(|| m.pointer("/top_provider/context_length").and_then(|v| v.as_u64()));
            Some(LlmModel { id, context_length })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// Svenskt felmeddelande för ett HTTP-fel från leverantören.
pub fn status_error(status: StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("message"))
                .or_else(|| v.get("detail"))
                .and_then(|m| m.as_str().map(str::to_string))
        })
        .map(|m| m.chars().take(300).collect::<String>());
    let base = match status.as_u16() {
        401 | 403 => "API-nyckeln godtogs inte. Kontrollera nyckeln i Inställningar.".to_string(),
        404 => "Adressen eller modellen hittades inte hos leverantören. Kontrollera server-URL och modell-ID.".to_string(),
        413 => "Texten är för lång för leverantören.".to_string(),
        429 => "Leverantören begränsar antalet anrop just nu. Vänta en stund och försök igen.".to_string(),
        s if s >= 500 => format!("Leverantören svarade med ett serverfel ({}). Försök igen senare.", s),
        s => format!("Leverantören svarade med status {}.", s),
    };
    match detail {
        Some(d) if !d.is_empty() => format!("{} ({})", base, d),
        _ => base,
    }
}

fn connection_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "Leverantören svarade inte i tid.".into()
    } else if e.is_connect() {
        "Kunde inte ansluta till servern. Kontrollera URL:en och nätverket.".into()
    } else {
        // reqwest-fel innehåller URL men aldrig headers, så nyckeln kan inte läcka här.
        format!("Anslutningsfel: {}", e)
    }
}

fn client(total_timeout: Option<Duration>) -> Result<Client, String> {
    let mut b = Client::builder().connect_timeout(CONNECT_TIMEOUT);
    if let Some(t) = total_timeout {
        b = b.timeout(t);
    }
    b.build().map_err(|e| format!("HTTP-klient kunde inte skapas: {}", e))
}

pub async fn list_models(endpoint: &Endpoint) -> Result<Vec<LlmModel>, String> {
    let resp = endpoint
        .authorize(client(Some(LIST_TIMEOUT))?.get(endpoint.url("models")))
        .send()
        .await
        .map_err(|e| connection_error(&e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| connection_error(&e))?;
    if !status.is_success() {
        return Err(status_error(status, &text));
    }
    let body: Value = serde_json::from_str(&text).map_err(|_| "Ogiltigt svar från /models.".to_string())?;
    Ok(parse_models(&body))
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionTest {
    pub ok: bool,
    pub message: String,
    pub models: Vec<LlmModel>,
}

/// Testa anslutningen: först `/models`, och om det inte stöds ett minimalt chat-anrop.
pub async fn test_connection(endpoint: &Endpoint, model: Option<&str>) -> ConnectionTest {
    match list_models(endpoint).await {
        Ok(models) => {
            let mut message = format!("Anslutningen fungerar. {} modeller hittades.", models.len());
            if let Some(m) = model.filter(|m| !m.is_empty()) {
                if !models.is_empty() && !models.iter().any(|x| x.id == m) {
                    message.push_str(&format!(" Obs: modellen \"{}\" finns inte i listan.", m));
                }
            }
            ConnectionTest { ok: true, message, models }
        }
        Err(list_err) => {
            let Some(m) = model.filter(|m| !m.is_empty()) else {
                return ConnectionTest {
                    ok: false,
                    message: format!("Modellistan kunde inte hämtas: {} Ange modell-ID för hand och testa igen.", list_err),
                    models: vec![],
                };
            };
            let req = ChatRequest {
                model: m.to_string(),
                messages: vec![ChatMessage::user("Svara med ordet OK.")],
                temperature: Some(0.0),
                max_tokens: Some(5),
                response_format: None,
            };
            match chat(endpoint, &req, None).await {
                Ok(_) => ConnectionTest {
                    ok: true,
                    message: "Anslutningen fungerar (modellistan stöds inte av servern).".into(),
                    models: vec![],
                },
                Err(e) => ConnectionTest { ok: false, message: e, models: vec![] },
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: &str) -> Self {
        Self { role: "system".into(), content: content.into() }
    }
    pub fn user(content: &str) -> Self {
        Self { role: "user".into(), content: content.into() }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
}

fn message_content(body: &Value) -> Option<String> {
    body.pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Ett chat-anrop utan strömning. Returnerar svarstexten.
pub async fn chat(endpoint: &Endpoint, req: &ChatRequest, cancelled: Option<Arc<AtomicBool>>) -> Result<String, String> {
    let send = endpoint
        .authorize(client(None)?.post(endpoint.url("chat/completions")))
        .json(req)
        .send();
    let resp = match cancelled {
        Some(flag) => {
            tokio::select! {
                r = send => r,
                _ = wait_cancelled(flag) => return Err(CANCELLED.into()),
            }
        }
        None => send.await,
    }
    .map_err(|e| connection_error(&e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| connection_error(&e))?;
    if !status.is_success() {
        return Err(status_error(status, &text));
    }
    let body: Value = serde_json::from_str(&text).map_err(|_| "Ogiltigt svar från leverantören.".to_string())?;
    message_content(&body).ok_or_else(|| "Svaret från leverantören saknade text.".into())
}

pub const CANCELLED: &str = "Bearbetningen avbröts.";

async fn wait_cancelled(flag: Arc<AtomicBool>) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[derive(Debug, PartialEq)]
pub enum SseItem {
    Delta(String),
    Done,
    Error(String),
}

/// Tolkar en Server-Sent Events-ström från `/chat/completions` med `stream: true`.
/// Data kan delas mitt i en rad mellan HTTP-chunkar, så ofullständiga rader buffras.
#[derive(Default)]
pub struct SseParser {
    buffer: String,
}

impl SseParser {
    pub fn push(&mut self, chunk: &str) -> Vec<SseItem> {
        self.buffer.push_str(chunk);
        let mut items = Vec::new();
        while let Some(pos) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=pos).collect();
            if let Some(item) = Self::parse_line(line.trim()) {
                items.push(item);
            }
        }
        items
    }

    pub fn finish(&mut self) -> Vec<SseItem> {
        let rest = std::mem::take(&mut self.buffer);
        Self::parse_line(rest.trim()).into_iter().collect()
    }

    fn parse_line(line: &str) -> Option<SseItem> {
        let data = line.strip_prefix("data:")?.trim();
        if data == "[DONE]" {
            return Some(SseItem::Done);
        }
        let v: Value = serde_json::from_str(data).ok()?;
        if let Some(err) = v.get("error") {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("okänt fel");
            return Some(SseItem::Error(format!("Leverantören rapporterade ett fel: {}", msg)));
        }
        let delta = v
            .pointer("/choices/0/delta/content")
            .or_else(|| v.pointer("/choices/0/message/content"))
            .and_then(|c| c.as_str())?;
        if delta.is_empty() {
            None
        } else {
            Some(SseItem::Delta(delta.to_string()))
        }
    }
}

/// Strömmande chat. `on_text` anropas med nya textbitar. Faller tillbaka på
/// vanligt JSON-svar om servern ignorerar `stream: true`.
pub async fn chat_stream<F>(
    endpoint: &Endpoint,
    req: &ChatRequest,
    cancelled: Arc<AtomicBool>,
    mut on_text: F,
) -> Result<String, String>
where
    F: FnMut(&str),
{
    let mut body = serde_json::to_value(req).map_err(|e| e.to_string())?;
    body["stream"] = Value::Bool(true);

    let send = endpoint
        .authorize(client(None)?.post(endpoint.url("chat/completions")))
        .json(&body)
        .send();
    let resp = tokio::select! {
        r = send => r.map_err(|e| connection_error(&e))?,
        _ = wait_cancelled(cancelled.clone()) => return Err(CANCELLED.into()),
    };
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(status_error(status, &text));
    }

    let is_sse = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("text/event-stream"))
        .unwrap_or(false);
    if !is_sse {
        let text = resp.text().await.map_err(|e| connection_error(&e))?;
        let v: Value = serde_json::from_str(&text).map_err(|_| "Ogiltigt svar från leverantören.".to_string())?;
        let content = message_content(&v).ok_or("Svaret från leverantören saknade text.")?;
        on_text(&content);
        return Ok(content);
    }

    let mut stream = resp.bytes_stream();
    let mut parser = SseParser::default();
    let mut full = String::new();
    let mut handle = |items: Vec<SseItem>, full: &mut String| -> Result<bool, String> {
        for item in items {
            match item {
                SseItem::Delta(t) => {
                    full.push_str(&t);
                    on_text(&t);
                }
                SseItem::Done => return Ok(true),
                SseItem::Error(e) => return Err(e),
            }
        }
        Ok(false)
    };

    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let next = tokio::select! {
            n = timeout(IDLE_TIMEOUT, stream.next()) => n,
            _ = wait_cancelled(cancelled.clone()) => return Err(CANCELLED.into()),
        };
        match next {
            Err(_) => return Err("Leverantören slutade svara (inget svar på 5 minuter).".into()),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(connection_error(&e)),
            Ok(Some(Ok(bytes))) => {
                if handle(parser.push(&String::from_utf8_lossy(&bytes)), &mut full)? {
                    return Ok(full);
                }
            }
        }
    }
    handle(parser.finish(), &mut full)?;
    Ok(full)
}

/// Aktiva genereringar som kan avbrytas, med request_id som nyckel.
#[derive(Default, Clone)]
pub struct CancellationMap {
    inner: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl CancellationMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, request_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.inner.lock().unwrap().insert(request_id.to_string(), flag.clone());
        flag
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        match self.inner.lock().unwrap().get(request_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub fn cancel_all(&self) {
        for flag in self.inner.lock().unwrap().values() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn remove(&self, request_id: &str) {
        self.inner.lock().unwrap().remove(request_id);
    }
}

/// Händelse till frontend under strömmande generering.
#[derive(Debug, Clone, Serialize)]
pub struct LlmEvent {
    pub request_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_text: Option<String>,
}

/// Samlar textbitar och släpper dem högst var 80:e ms för att inte dränka webbvyn.
pub struct TokenBatcher {
    pending: String,
    last: Instant,
}

impl Default for TokenBatcher {
    fn default() -> Self {
        Self { pending: String::new(), last: Instant::now() }
    }
}

impl TokenBatcher {
    pub fn push(&mut self, text: &str) -> Option<String> {
        self.pending.push_str(text);
        if self.last.elapsed().as_millis() >= 80 {
            self.last = Instant::now();
            Some(std::mem::take(&mut self.pending))
        } else {
            None
        }
    }

    pub fn flush(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.pending))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn normalizes_base_url() {
        assert_eq!(normalize_base_url(" https://api.berget.ai/v1/ ").unwrap(), "https://api.berget.ai/v1");
        assert_eq!(normalize_base_url("http://localhost:11434/v1").unwrap(), "http://localhost:11434/v1");
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("api.berget.ai/v1").is_err());
        assert!(normalize_base_url("ftp://x").is_err());
    }

    #[test]
    fn debug_hides_api_key() {
        let ep = Endpoint::new("https://x/v1", Some("sk-hemlig".into())).unwrap();
        let dbg = format!("{:?}", ep);
        assert!(!dbg.contains("sk-hemlig"));
        assert!(dbg.contains("<dold>"));
    }

    #[test]
    fn empty_key_means_no_key() {
        assert!(Endpoint::new("https://x", Some("  ".into())).unwrap().api_key.is_none());
    }

    #[test]
    fn parses_openai_models_with_ids_only() {
        let body = json!({"object": "list", "data": [{"id": "b-modell", "object": "model"}, {"id": "a-modell"}]});
        assert_eq!(
            parse_models(&body),
            vec![
                LlmModel { id: "a-modell".into(), context_length: None },
                LlmModel { id: "b-modell".into(), context_length: None },
            ]
        );
    }

    #[test]
    fn parses_extra_context_fields_and_other_shapes() {
        let body = json!({"data": [
            {"id": "x", "context_length": 128000},
            {"id": "y", "max_model_len": 32768},
            {"id": "z", "top_provider": {"context_length": 8192}},
            {"id": ""},
            {"id": "x"}
        ]});
        let models = parse_models(&body);
        assert_eq!(models.iter().map(|m| (m.id.as_str(), m.context_length)).collect::<Vec<_>>(),
                   vec![("x", Some(128000)), ("y", Some(32768)), ("z", Some(8192))]);
        assert_eq!(parse_models(&json!(["m1", "m2"])).len(), 2);
        assert_eq!(parse_models(&json!({"models": [{"name": "llama3"}]}))[0].id, "llama3");
        assert!(parse_models(&json!({"oväntat": true})).is_empty());
    }

    #[test]
    fn status_errors_are_swedish_and_include_server_detail() {
        let e = status_error(StatusCode::UNAUTHORIZED, r#"{"error":{"message":"invalid key"}}"#);
        assert!(e.starts_with("API-nyckeln godtogs inte"));
        assert!(e.contains("invalid key"));
        assert!(status_error(StatusCode::NOT_FOUND, "").contains("hittades inte"));
        assert!(status_error(StatusCode::TOO_MANY_REQUESTS, "x").contains("begränsar"));
        assert!(status_error(StatusCode::BAD_GATEWAY, "").contains("serverfel (502)"));
    }

    #[test]
    fn sse_parser_handles_split_lines_done_and_errors() {
        let mut p = SseParser::default();
        assert_eq!(
            p.push("data: {\"choices\":[{\"delta\":{\"content\":\"Hej\"}}]}\n\nda"),
            vec![SseItem::Delta("Hej".into())]
        );
        let items = p.push("ta: {\"choices\":[{\"delta\":{\"content\":\" där\"}}]}\n: keepalive\n\ndata: [DONE]\n");
        assert_eq!(items, vec![SseItem::Delta(" där".into()), SseItem::Done]);

        let mut p = SseParser::default();
        assert_eq!(p.push("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n"), vec![]);
        assert_eq!(
            p.push("data: {\"error\":{\"message\":\"överbelastad\"}}\n"),
            vec![SseItem::Error("Leverantören rapporterade ett fel: överbelastad".into())]
        );

        let mut p = SseParser::default();
        assert!(p.push("data: {\"choices\":[{\"delta\":{\"content\":\"slut\"}}]}").is_empty());
        assert_eq!(p.finish(), vec![SseItem::Delta("slut".into())]);
    }

    #[test]
    fn chat_request_omits_unset_fields() {
        let req = ChatRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("hej")],
            temperature: None,
            max_tokens: Some(10),
            response_format: None,
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v, json!({"model": "m", "messages": [{"role": "user", "content": "hej"}], "max_tokens": 10}));
    }

    #[test]
    fn cancellation_map() {
        let map = CancellationMap::new();
        let flag = map.register("r1");
        assert!(map.cancel("r1"));
        assert!(flag.load(Ordering::Relaxed));
        map.remove("r1");
        assert!(!map.cancel("r1"));
    }

    /// Minimal HTTP-server som svarar med ett förbestämt svar och sparar begäran.
    async fn serve_once(status: &'static str, content_type: &'static str, body: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let mut req = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                req.extend_from_slice(&buf[..n]);
                let s = String::from_utf8_lossy(&req).to_string();
                if let Some(h) = s.find("\r\n\r\n") {
                    let len = s[..h]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if req.len() >= h + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let resp = format!(
                "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status, content_type, body.len(), body
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&req).to_string()
        });
        (format!("http://{}/v1", addr), handle)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_models_sends_bearer_and_parses() {
        let (url, server) = serve_once("200 OK", "application/json", json!({"data": [{"id": "google/gemma-4-31B-it"}]}).to_string()).await;
        let ep = Endpoint::new(&url, Some("sk-test".into())).unwrap();
        let models = list_models(&ep).await.unwrap();
        assert_eq!(models[0].id, "google/gemma-4-31B-it");
        let req = server.await.unwrap();
        assert!(req.starts_with("GET /v1/models "));
        assert!(req.to_ascii_lowercase().contains("authorization: bearer sk-test"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_key_sends_no_authorization_header() {
        let (url, server) = serve_once("200 OK", "application/json", json!({"data": []}).to_string()).await;
        list_models(&Endpoint::new(&url, None).unwrap()).await.unwrap();
        assert!(!server.await.unwrap().to_ascii_lowercase().contains("authorization"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_models_maps_http_errors() {
        let (url, _server) = serve_once("401 Unauthorized", "application/json", r#"{"error":{"message":"bad key"}}"#.into()).await;
        let err = list_models(&Endpoint::new(&url, Some("x".into())).unwrap()).await.unwrap_err();
        assert!(err.starts_with("API-nyckeln godtogs inte"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_reads_sse() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Mötet \"}}]}\n\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\"handlade om budget.\"}}]}\n\n\
                   data: [DONE]\n\n".to_string();
        let (url, server) = serve_once("200 OK", "text/event-stream", sse).await;
        let ep = Endpoint::new(&url, Some("k".into())).unwrap();
        let req = ChatRequest {
            model: "m".into(),
            messages: vec![ChatMessage::system("Svara på svenska."), ChatMessage::user("Sammanfatta")],
            temperature: Some(0.3),
            max_tokens: None,
            response_format: None,
        };
        let mut pieces = Vec::new();
        let text = chat_stream(&ep, &req, Arc::new(AtomicBool::new(false)), |t| pieces.push(t.to_string())).await.unwrap();
        assert_eq!(text, "Mötet handlade om budget.");
        assert_eq!(pieces.len(), 2);
        let raw = server.await.unwrap();
        assert!(raw.starts_with("POST /v1/chat/completions "));
        let body: Value = serde_json::from_str(&raw[raw.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["messages"][0]["role"], "system");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_stream_falls_back_to_plain_json() {
        let (url, _server) = serve_once("200 OK", "application/json",
            json!({"choices": [{"message": {"role": "assistant", "content": "Kort svar."}}]}).to_string()).await;
        let req = ChatRequest { model: "m".into(), messages: vec![ChatMessage::user("x")], temperature: None, max_tokens: None, response_format: None };
        let text = chat_stream(&Endpoint::new(&url, None).unwrap(), &req, Arc::new(AtomicBool::new(false)), |_| {}).await.unwrap();
        assert_eq!(text, "Kort svar.");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn test_connection_falls_back_to_chat_when_models_missing() {
        // /models ger 404 → chat-anrop krävs men ingen modell angiven → tydligt fel
        let (url, _s) = serve_once("404 Not Found", "application/json", "{}".into()).await;
        let res = test_connection(&Endpoint::new(&url, None).unwrap(), None).await;
        assert!(!res.ok);
        assert!(res.message.contains("Ange modell-ID för hand"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_before_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        // Servern accepterar men svarar aldrig
        let _keep = tokio::spawn(async move {
            let (_sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let flag = Arc::new(AtomicBool::new(false));
        let f2 = flag.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            f2.store(true, Ordering::Relaxed);
        });
        let req = ChatRequest { model: "m".into(), messages: vec![], temperature: None, max_tokens: None, response_format: None };
        let err = chat_stream(&Endpoint::new(&url, None).unwrap(), &req, flag, |_| {}).await.unwrap_err();
        assert_eq!(err, CANCELLED);
    }
}
