use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaOptions {
    pub temperature: Option<f64>,
    pub num_ctx: Option<u32>,
    pub num_predict: Option<u32>,
    pub repeat_penalty: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaEvent {
    pub request_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_text: Option<String>,
}

pub async fn check_health(base_url: &str) -> bool {
    let url = base_url.trim_end_matches('/');
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    client.get(url).send().await.is_ok()
}

pub async fn list_models(base_url: &str) -> Result<Vec<OllamaModel>, String> {
    let url = base_url.trim_end_matches('/');
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP-klient kunde inte skapas: {}", e))?;

    let resp = client
        .get(format!("{}/api/tags", url))
        .send()
        .await
        .map_err(|e| format!("Kunde inte ansluta till Ollama: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Ogiltigt svar från Ollama: {}", e))?;

    let models = body["models"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| {
            Some(OllamaModel {
                name: m["name"].as_str()?.to_string(),
                size: m["size"].as_u64().unwrap_or(0),
            })
        })
        .collect();

    Ok(models)
}

pub async fn generate_streaming(
    app: &AppHandle,
    model: &str,
    prompt: &str,
    request_id: &str,
    options: Option<OllamaOptions>,
    base_url: &str,
) -> Result<String, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP-klient kunde inte skapas: {}", e))?;

    let opts = options.unwrap_or(OllamaOptions {
        temperature: None,
        num_ctx: None,
        num_predict: None,
        repeat_penalty: None,
    });

    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": true,
        "options": {
            "num_ctx": opts.num_ctx.unwrap_or(4096),
            "num_predict": opts.num_predict.unwrap_or(2048),
            "temperature": opts.temperature.unwrap_or(0.3),
            "repeat_penalty": opts.repeat_penalty.unwrap_or(1.1),
        },
    });

    let url = base_url.trim_end_matches('/');

    let resp = client
        .post(format!("{}/api/generate", url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Kunde inte ansluta till Ollama: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama svarade med status {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut full_text = String::new();
    let mut seq: u64 = 0;
    let mut pending_tokens = String::new();
    let mut last_emit = Instant::now();
    const BATCH_INTERVAL_MS: u128 = 80;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Strömningsfel: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);

        // Ollama streams NDJSON — each line is a JSON object
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(token) = parsed["response"].as_str() {
                    full_text.push_str(token);
                    pending_tokens.push_str(token);

                    // Batch token events: emit at most every ~80ms
                    if last_emit.elapsed().as_millis() >= BATCH_INTERVAL_MS {
                        seq += 1;
                        let _ = app.emit(
                            "ollama-event",
                            OllamaEvent {
                                request_id: request_id.to_string(),
                                event_type: "token".to_string(),
                                seq,
                                token: Some(std::mem::take(&mut pending_tokens)),
                                done: None,
                                error: None,
                                full_text: None,
                            },
                        );
                        last_emit = Instant::now();
                    }
                }
                if parsed["done"].as_bool() == Some(true) {
                    // Flush any remaining pending tokens
                    if !pending_tokens.is_empty() {
                        seq += 1;
                        let _ = app.emit(
                            "ollama-event",
                            OllamaEvent {
                                request_id: request_id.to_string(),
                                event_type: "token".to_string(),
                                seq,
                                token: Some(std::mem::take(&mut pending_tokens)),
                                done: None,
                                error: None,
                                full_text: None,
                            },
                        );
                    }
                    seq += 1;
                    let _ = app.emit(
                        "ollama-event",
                        OllamaEvent {
                            request_id: request_id.to_string(),
                            event_type: "done".to_string(),
                            seq,
                            token: None,
                            done: Some(true),
                            error: None,
                            full_text: Some(full_text.clone()),
                        },
                    );
                }
            }
        }
    }

    Ok(full_text)
}
