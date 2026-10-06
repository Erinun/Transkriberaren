//! API-nycklar för AI-leverantörer, lagrade i operativsystemets nyckelförvaring
//! (Windows Credential Manager). Nycklarna lämnas aldrig ut till webbvyn och
//! skrivs aldrig till loggar.

const SERVICE: &str = "se.motesskribent.app";

pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// Operativsystemets nyckelförvaring via `keyring`.
pub struct OsKeyring;

impl SecretStore for OsKeyring {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| format!("Kunde inte spara API-nyckeln i nyckelförvaringen: {}", e))
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(SERVICE, account).and_then(|e| e.get_password()) {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Kunde inte läsa API-nyckeln från nyckelförvaringen: {}", e)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match keyring::Entry::new(SERVICE, account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Kunde inte ta bort API-nyckeln: {}", e)),
        }
    }
}

/// Kontonamn i nyckelförvaringen för en leverantör. Id:t valideras så att
/// webbvyn inte kan peka ut godtyckliga poster.
pub fn account_for(provider_id: &str) -> Result<String, String> {
    let valid = !provider_id.is_empty()
        && provider_id.len() <= 64
        && provider_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !valid {
        return Err(format!("Ogiltigt leverantörs-id: {}", provider_id));
    }
    Ok(format!("llm-api-key:{}", provider_id))
}

pub fn set_api_key(store: &dyn SecretStore, provider_id: &str, api_key: &str) -> Result<(), String> {
    let account = account_for(provider_id)?;
    let key = api_key.trim();
    if key.is_empty() {
        store.delete(&account)
    } else {
        store.set(&account, key)
    }
}

pub fn get_api_key(store: &dyn SecretStore, provider_id: &str) -> Result<Option<String>, String> {
    store.get(&account_for(provider_id)?)
}

pub fn delete_api_key(store: &dyn SecretStore, provider_id: &str) -> Result<(), String> {
    store.delete(&account_for(provider_id)?)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(account.into(), secret.into());
            Ok(())
        }
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn roundtrip_trims_and_empty_deletes() {
        let store = MemoryStore::default();
        set_api_key(&store, "berget", "  sk-abc  ").unwrap();
        assert_eq!(get_api_key(&store, "berget").unwrap().as_deref(), Some("sk-abc"));
        set_api_key(&store, "berget", "   ").unwrap();
        assert_eq!(get_api_key(&store, "berget").unwrap(), None);
    }

    #[test]
    fn keys_are_separate_per_provider() {
        let store = MemoryStore::default();
        set_api_key(&store, "berget", "a").unwrap();
        set_api_key(&store, "custom", "b").unwrap();
        delete_api_key(&store, "berget").unwrap();
        assert_eq!(get_api_key(&store, "berget").unwrap(), None);
        assert_eq!(get_api_key(&store, "custom").unwrap().as_deref(), Some("b"));
    }

    #[test]
    fn rejects_invalid_provider_ids() {
        for bad in ["", "Berget", "../x", "a b", "x:y", &"a".repeat(65)] {
            assert!(account_for(bad).is_err(), "{bad} borde avvisas");
        }
        assert_eq!(account_for("egen-1").unwrap(), "llm-api-key:egen-1");
    }

    #[test]
    fn error_messages_never_contain_the_secret() {
        struct Failing;
        impl SecretStore for Failing {
            fn set(&self, _: &str, _: &str) -> Result<(), String> { Err("Kunde inte spara".into()) }
            fn get(&self, _: &str) -> Result<Option<String>, String> { Ok(None) }
            fn delete(&self, _: &str) -> Result<(), String> { Ok(()) }
        }
        let err = set_api_key(&Failing, "berget", "sk-hemlig").unwrap_err();
        assert!(!err.contains("sk-hemlig"));
    }
}
