use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const OLLAMA_BASE: &str = "http://localhost:11434";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OllamaEvent {
    pub request_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_text: Option<String>,
}

pub async fn check_health() -> bool {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    client.get(OLLAMA_BASE).send().await.is_ok()
}

pub async fn list_models() -> Result<Vec<OllamaModel>, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("HTTP-klient kunde inte skapas: {}", e))?;

    let resp = client
        .get(format!("{}/api/tags", OLLAMA_BASE))
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
) -> Result<String, String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP-klient kunde inte skapas: {}", e))?;

    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": true,
    });

    let resp = client
        .post(format!("{}/api/generate", OLLAMA_BASE))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Kunde inte ansluta till Ollama: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Ollama svarade med status {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut full_text = String::new();

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
                    let _ = app.emit(
                        "ollama-event",
                        OllamaEvent {
                            request_id: request_id.to_string(),
                            event_type: "token".to_string(),
                            token: Some(token.to_string()),
                            done: None,
                            error: None,
                            full_text: None,
                        },
                    );
                }
                if parsed["done"].as_bool() == Some(true) {
                    let _ = app.emit(
                        "ollama-event",
                        OllamaEvent {
                            request_id: request_id.to_string(),
                            event_type: "done".to_string(),
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
