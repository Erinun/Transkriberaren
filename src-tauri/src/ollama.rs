use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::time::{timeout, Duration};

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
        .connect_timeout(Duration::from_secs(10))
        // No total timeout — streaming can take as long as needed on CPU
        .build()
        .map_err(|e| format!("HTTP-klient kunde inte skapas: {}", e))?;

    let opts = options.unwrap_or(OllamaOptions {
        temperature: None,
        num_ctx: None,
        num_predict: None,
        repeat_penalty: None,
    });

    // Auto-adjust num_ctx if the prompt is too large for the configured context window
    let user_num_ctx = opts.num_ctx.unwrap_or(8192);
    let user_num_predict = opts.num_predict.unwrap_or(4096);
    // Rough token estimate: ~4 characters per token for Swedish text
    let estimated_prompt_tokens = (prompt.len() as u32) / 4;
    let min_ctx_needed = estimated_prompt_tokens + user_num_predict + 256;
    let effective_num_ctx = if min_ctx_needed > user_num_ctx {
        let capped = min_ctx_needed.min(131072);
        log::info!(
            "Auto-höjer num_ctx: {} -> {} (prompt ~{} tokens, num_predict {})",
            user_num_ctx,
            capped,
            estimated_prompt_tokens,
            user_num_predict
        );
        capped
    } else {
        user_num_ctx
    };

    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": true,
        "options": {
            "num_ctx": effective_num_ctx,
            "num_predict": user_num_predict,
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

    const IDLE_TIMEOUT: Duration = Duration::from_secs(180);

    loop {
        let chunk = match timeout(IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break, // Stream ended normally
            Err(_) => {
                let msg = "Ollama svarade inte inom 3 minuter. Modellen kan ha fastnat eller vara överbelastad. Försök igen med en mindre modell eller kortare text.".to_string();
                seq += 1;
                let _ = app.emit(
                    "ollama-event",
                    OllamaEvent {
                        request_id: request_id.to_string(),
                        event_type: "error".to_string(),
                        seq,
                        token: None,
                        done: None,
                        error: Some(msg.clone()),
                        full_text: None,
                    },
                );
                return Err(msg);
            }
        };

        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let msg = if e.is_timeout() {
                    "Tidsgräns överskreds. Ollama-genereringen tog för lång tid. Försök med en mindre modell eller kortare transkribering.".to_string()
                } else if e.is_connect() {
                    "Kunde inte ansluta till Ollama. Kontrollera att Ollama körs och att server-URL:en är korrekt.".to_string()
                } else if e.is_decode() {
                    "Anslutningen till Ollama avbröts under generering. Detta kan bero på att modellen tar slut på minne. Försök med en mindre modell.".to_string()
                } else {
                    format!("Strömningsfel: {}", e)
                };
                seq += 1;
                let _ = app.emit(
                    "ollama-event",
                    OllamaEvent {
                        request_id: request_id.to_string(),
                        event_type: "error".to_string(),
                        seq,
                        token: None,
                        done: None,
                        error: Some(msg.clone()),
                        full_text: None,
                    },
                );
                return Err(msg);
            }
        };

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
