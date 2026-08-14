use chrono::Utc;
use keyring::Entry;
use lazy_static::lazy_static;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tokio::sync::Mutex;

use crate::cloud_auth::{CloudAuthState, CloudUser, Entitlements};
use crate::settings_manager::SettingsManager;

pub const COMPANY_API_URL: &str = "https://browser.sanheqiyun.xyz/api";
pub const COMPANY_SYNC_URL: &str = "https://browser.sanheqiyun.xyz/sync";

const CREDENTIAL_SERVICE: &str = "Sanhe Donut Browser";

pub fn device_id() -> String {
  let path = SettingsManager::instance()
    .get_settings_dir()
    .join("company_device_id");
  if let Ok(value) = std::fs::read_to_string(&path) {
    let value = value.trim();
    if !value.is_empty() {
      return value.to_string();
    }
  }
  let value = uuid::Uuid::new_v4().to_string();
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let _ = std::fs::write(&path, &value);
  crate::app_dirs::restrict_to_owner(&path);
  value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanyUser {
  pub id: String,
  pub username: String,
  pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyAdminUser {
  pub id: String,
  pub username: String,
  pub role: String,
  pub active: bool,
  pub assigned_profile_count: i64,
  pub created_at: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyManagedProfile {
  pub id: String,
  pub owner_id: String,
  #[serde(default)]
  pub assigned_user_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyAdminOverview {
  pub users: Vec<CompanyAdminUser>,
  pub profiles: Vec<CompanyManagedProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompanyBatchTransferResponse {
  updated: usize,
  profile_ids: Vec<String>,
  target_user_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct CompanyProfileAccessCache {
  checked_at: String,
  profile_ids: HashSet<String>,
}

#[derive(Debug, Deserialize)]
struct LoginResponse {
  #[serde(rename = "accessToken")]
  access_token: String,
  #[serde(rename = "refreshToken")]
  refresh_token: String,
  user: CompanyUser,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
  #[serde(rename = "accessToken")]
  access_token: String,
  #[serde(rename = "refreshToken")]
  refresh_token: String,
}

pub struct CompanyAuthManager {
  client: Client,
  state: Mutex<Option<CloudAuthState>>,
  refresh_lock: Mutex<()>,
}

lazy_static! {
  pub static ref COMPANY_AUTH: CompanyAuthManager = CompanyAuthManager::new();
}

impl CompanyAuthManager {
  fn new() -> Self {
    let state = Self::load_state();
    Self {
      client: Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| Client::new()),
      state: Mutex::new(state),
      refresh_lock: Mutex::new(()),
    }
  }

  fn credential(name: &str) -> Result<Entry, String> {
    // Keep each token in a separate Windows Credential Manager target. The
    // service name is the target namespace on Windows; relying on different
    // usernames alone is not portable across keyring backends.
    Entry::new(&format!("{CREDENTIAL_SERVICE} {name}"), name)
      .map_err(|e| format!("Credential store error: {e}"))
  }

  fn legacy_credential(name: &str) -> Result<Entry, String> {
    Entry::new(CREDENTIAL_SERVICE, name).map_err(|e| format!("Credential store error: {e}"))
  }

  fn token_backup_path(name: &str) -> std::path::PathBuf {
    SettingsManager::instance()
      .get_settings_dir()
      .join(format!("{name}.token"))
  }

  fn store_token(name: &str, token: &str) -> Result<(), String> {
    let credential_result = Self::credential(name)?
      .set_password(token)
      .map_err(|e| format!("Credential store error: {e}"));
    // Also persist with the app's existing Argon2 + AES-GCM encrypted token
    // format. This is a recovery copy for Windows machines where Credential
    // Manager intermittently reports NoEntry/NoStorageAccess.
    SettingsManager::instance()
      .store_secret_token(&Self::token_backup_path(name), b"DBCTK", token)
      .map_err(|e| format!("Encrypted token backup error: {e}"))?;
    credential_result
  }

  fn load_token(name: &str) -> Result<Option<String>, String> {
    if let Ok(value) = Self::credential(name).and_then(|entry| {
      entry
        .get_password()
        .map_err(|e| format!("Credential store error: {e}"))
    }) {
      return Ok(Some(value));
    }
    if let Some(value) = SettingsManager::instance()
      .load_secret_token(&Self::token_backup_path(name), b"DBCTK")
      .map_err(|e| format!("Encrypted token backup error: {e}"))?
    {
      return Ok(Some(value));
    }
    // Migrate credentials written by 0.28.2, which used a shared service
    // target. This path is read only when neither new store is populated.
    match Self::legacy_credential(name)?.get_password() {
      Ok(value) => {
        let _ = Self::store_token(name, &value);
        Ok(Some(value))
      }
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(e) => Err(format!("Credential store error: {e}")),
    }
  }

  fn delete_token(name: &str) {
    if let Ok(entry) = Self::credential(name) {
      let _ = entry.delete_credential();
    }
    if let Ok(entry) = Self::legacy_credential(name) {
      let _ = entry.delete_credential();
    }
    let _ = std::fs::remove_file(Self::token_backup_path(name));
  }

  fn state_path() -> std::path::PathBuf {
    SettingsManager::instance()
      .get_settings_dir()
      .join("company_auth_state.json")
  }

  fn profile_access_path() -> std::path::PathBuf {
    SettingsManager::instance()
      .get_settings_dir()
      .join("company_profile_access.json")
  }

  fn save_profile_access(profile_ids: &HashSet<String>) -> Result<(), String> {
    let path = Self::profile_access_path();
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create access cache directory: {e}"))?;
    }
    let cache = CompanyProfileAccessCache {
      checked_at: Utc::now().to_rfc3339(),
      profile_ids: profile_ids.clone(),
    };
    std::fs::write(
      &path,
      serde_json::to_vec_pretty(&cache).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to save profile access cache: {e}"))?;
    crate::app_dirs::restrict_to_owner(&path);
    Ok(())
  }

  fn load_state() -> Option<CloudAuthState> {
    let content = std::fs::read_to_string(Self::state_path()).ok()?;
    serde_json::from_str(&content).ok()
  }

  fn save_state(state: &CloudAuthState) -> Result<(), String> {
    let path = Self::state_path();
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create auth directory: {e}"))?;
    }
    std::fs::write(
      &path,
      serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to save auth state: {e}"))?;
    crate::app_dirs::restrict_to_owner(&path);
    Ok(())
  }

  fn cloud_user(user: CompanyUser) -> CloudUser {
    CloudUser {
      id: user.id,
      email: user.username,
      plan: "internal".to_string(),
      plan_period: None,
      subscription_status: "active".to_string(),
      profile_limit: 500,
      cloud_profiles_used: 0,
      proxy_bandwidth_limit_mb: 0,
      proxy_bandwidth_used_mb: 0,
      proxy_bandwidth_extra_mb: 0,
      team_id: Some("sanhe-company".to_string()),
      team_name: Some("Sanhe".to_string()),
      team_role: Some(user.role),
      device_ordinal: None,
      device_count: None,
      is_primary_device: None,
      // Internal login enables collaboration/sync only. It deliberately does
      // not grant Donut Pro automation or cross-OS fingerprint capabilities.
      entitlements: Some(Entitlements {
        active: true,
        browser_automation: false,
        cross_os_fingerprints: false,
        cloud_backup: true,
        team_collaboration: true,
        profile_limit: 500,
        requests_per_hour: 0,
      }),
    }
  }

  pub async fn login(
    &self,
    app_handle: &tauri::AppHandle,
    username: &str,
    password: &str,
  ) -> Result<CloudAuthState, String> {
    let response = self
      .client
      .post(format!("{COMPANY_API_URL}/auth/login"))
      .json(&serde_json::json!({ "username": username, "password": password }))
      .send()
      .await
      .map_err(|e| format!("Login request failed: {e}"))?;
    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(format!("Login failed ({status}): {body}"));
    }
    let result: LoginResponse = response
      .json()
      .await
      .map_err(|e| format!("Invalid login response: {e}"))?;
    Self::store_token("company-access", &result.access_token)?;
    Self::store_token("company-refresh", &result.refresh_token)?;
    let state = CloudAuthState {
      user: Self::cloud_user(result.user),
      logged_in_at: Utc::now().to_rfc3339(),
    };
    Self::save_state(&state)?;
    SettingsManager::instance()
      .save_sync_server_url(Some(COMPANY_SYNC_URL.to_string()))
      .map_err(|e| format!("Failed to configure sync server: {e}"))?;
    SettingsManager::instance()
      .store_sync_token(app_handle, &result.access_token)
      .await
      .map_err(|e| format!("Failed to store sync token: {e}"))?;
    *self.state.lock().await = Some(state.clone());
    self.visible_profile_ids(app_handle).await?;
    let _ = crate::events::emit_empty("cloud-auth-changed");
    let _ = crate::events::emit("profiles-changed", ());
    Ok(state)
  }

  pub async fn refresh(&self, app_handle: &tauri::AppHandle) -> Result<String, String> {
    let _refresh_guard = self.refresh_lock.lock().await;
    self.refresh_unlocked(app_handle).await
  }

  async fn refresh_unlocked(&self, app_handle: &tauri::AppHandle) -> Result<String, String> {
    let refresh =
      Self::load_token("company-refresh")?.ok_or_else(|| "No company refresh token".to_string())?;
    let response = self
      .client
      .post(format!("{COMPANY_API_URL}/auth/refresh"))
      .json(&serde_json::json!({ "refreshToken": refresh }))
      .send()
      .await
      .map_err(|e| format!("Token refresh failed: {e}"))?;
    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(format!("Token refresh failed ({status}): {body}"));
    }
    let result: RefreshResponse = response.json().await.map_err(|e| e.to_string())?;
    Self::store_token("company-access", &result.access_token)?;
    Self::store_token("company-refresh", &result.refresh_token)?;
    SettingsManager::instance()
      .store_sync_token(app_handle, &result.access_token)
      .await
      .map_err(|e| format!("Failed to update sync token: {e}"))?;
    let state_snapshot = { self.state.lock().await.clone() };
    if let Some(mut state) = state_snapshot {
      // This timestamp represents the most recent successful authorization
      // verification and is the anchor for the seven-day offline window.
      state.logged_in_at = Utc::now().to_rfc3339();
      Self::save_state(&state)?;
      *self.state.lock().await = Some(state);
    }
    Ok(result.access_token)
  }

  fn is_jwt_expiring_soon(token: &str) -> bool {
    use base64::{engine::general_purpose, Engine as _};

    let mut parts = token.split('.');
    let Some(_) = parts.next() else {
      return true;
    };
    let Some(payload) = parts.next() else {
      return true;
    };
    if parts.next().is_none() {
      return true;
    }
    let decoded = general_purpose::URL_SAFE_NO_PAD
      .decode(payload)
      .or_else(|_| general_purpose::STANDARD.decode(payload));
    let Ok(decoded) = decoded else {
      return true;
    };
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&decoded) else {
      return true;
    };
    let Some(expires_at) = json.get("exp").and_then(|value| value.as_i64()) else {
      return true;
    };
    expires_at - Utc::now().timestamp() < 120
  }

  pub async fn get_or_refresh_access_token(
    &self,
    app_handle: &tauri::AppHandle,
  ) -> Result<String, String> {
    let token = Self::access_token()?.ok_or_else(|| "Not logged in".to_string())?;
    if !Self::is_jwt_expiring_soon(&token) {
      return Ok(token);
    }

    let _refresh_guard = self.refresh_lock.lock().await;
    let latest = Self::access_token()?.ok_or_else(|| "Not logged in".to_string())?;
    if !Self::is_jwt_expiring_soon(&latest) {
      return Ok(latest);
    }
    self.refresh_unlocked(app_handle).await
  }

  pub fn access_token() -> Result<Option<String>, String> {
    match Self::load_token("company-access") {
      Ok(Some(token)) => Ok(Some(token)),
      Ok(None) | Err(_) => {
        // Windows Credential Manager is the primary store. Some Windows
        // installations can nevertheless return NoEntry/NoStorageAccess after
        // a successful login. The sync engine already keeps the same short-
        // lived access token in its encrypted v2 token file, so use that as a
        // recovery source when this is the configured company endpoint.
        let manager = SettingsManager::instance();
        let settings = manager
          .load_settings()
          .map_err(|e| format!("Failed to load company sync settings: {e}"))?;
        if settings.sync_server_url.as_deref() != Some(COMPANY_SYNC_URL) {
          return Ok(None);
        }
        manager
          .get_sync_token_from_disk()
          .map_err(|e| format!("Failed to recover company access token: {e}"))
      }
    }
  }

  pub async fn visible_profile_ids(
    &self,
    app_handle: &tauri::AppHandle,
  ) -> Result<Option<HashSet<String>>, String> {
    if !self.is_logged_in().await {
      return Ok(None);
    }
    let access = self.get_or_refresh_access_token(app_handle).await?;
    let mut response = match self
      .client
      .get(format!("{COMPANY_API_URL}/profiles"))
      .bearer_auth(access)
      .send()
      .await
    {
      Ok(response) => response,
      Err(error) => {
        if let Some(profile_ids) = self.cached_profile_ids().await {
          return Ok(Some(profile_ids));
        }
        return Err(format!("Failed to load assigned profiles: {error}"));
      }
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
      let refreshed = self.refresh(app_handle).await?;
      response = self
        .client
        .get(format!("{COMPANY_API_URL}/profiles"))
        .bearer_auth(refreshed)
        .send()
        .await
        .map_err(|error| format!("Failed to load assigned profiles: {error}"))?;
    }
    if !response.status().is_success() {
      return Err(format!(
        "Failed to load assigned profiles ({})",
        response.status()
      ));
    }
    let profiles: Vec<serde_json::Value> = response
      .json()
      .await
      .map_err(|e| format!("Invalid assigned profile response: {e}"))?;
    let profile_ids = profiles
      .iter()
      .filter_map(|profile| profile.get("id").and_then(|id| id.as_str()))
      .map(str::to_string)
      .collect();
    Self::save_profile_access(&profile_ids)?;
    Ok(Some(profile_ids))
  }

  async fn require_super_admin_access(
    &self,
    app_handle: &tauri::AppHandle,
  ) -> Result<String, String> {
    let state = self
      .state()
      .await
      .ok_or_else(|| serde_json::json!({ "code": "COMPANY_NOT_LOGGED_IN" }).to_string())?;
    if state.user.team_role.as_deref() != Some("super_admin") {
      return Err(serde_json::json!({ "code": "COMPANY_SUPER_ADMIN_REQUIRED" }).to_string());
    }
    self
      .get_or_refresh_access_token(app_handle)
      .await
      .map_err(|_| serde_json::json!({ "code": "COMPANY_ADMIN_REQUEST_FAILED" }).to_string())
  }

  async fn send_admin_request<F>(
    &self,
    app_handle: &tauri::AppHandle,
    build: F,
  ) -> Result<reqwest::Response, String>
  where
    F: Fn(&Client, &str) -> reqwest::RequestBuilder,
  {
    let access = self.require_super_admin_access(app_handle).await?;
    let mut response = build(&self.client, &access)
      .send()
      .await
      .map_err(|_| serde_json::json!({ "code": "COMPANY_ADMIN_REQUEST_FAILED" }).to_string())?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
      let refreshed = self
        .refresh(app_handle)
        .await
        .map_err(|_| serde_json::json!({ "code": "COMPANY_ADMIN_REQUEST_FAILED" }).to_string())?;
      response = build(&self.client, &refreshed)
        .send()
        .await
        .map_err(|_| serde_json::json!({ "code": "COMPANY_ADMIN_REQUEST_FAILED" }).to_string())?;
    }
    Ok(response)
  }

  async fn admin_response_error(response: reqwest::Response, fallback: &str) -> String {
    let status = response.status().as_u16();
    let body = response
      .json::<serde_json::Value>()
      .await
      .unwrap_or_else(|_| serde_json::json!({}));
    let code = body
      .get("code")
      .and_then(|value| value.as_str())
      .unwrap_or(fallback);
    let mut params = serde_json::Map::new();
    params.insert("status".to_string(), serde_json::json!(status));
    if let Some(profile_ids) = body.get("profileIds").and_then(|value| value.as_array()) {
      params.insert(
        "count".to_string(),
        serde_json::json!(profile_ids.len().to_string()),
      );
    }
    if code == "PASSWORD_TOO_SHORT" {
      params.insert("min".to_string(), serde_json::json!("12"));
    }
    serde_json::json!({ "code": code, "params": params }).to_string()
  }

  pub async fn admin_overview(
    &self,
    app_handle: &tauri::AppHandle,
  ) -> Result<CompanyAdminOverview, String> {
    let (users_response, profiles_response) = tokio::join!(
      self.send_admin_request(app_handle, |client, access| {
        client
          .get(format!("{COMPANY_API_URL}/users"))
          .bearer_auth(access)
      }),
      self.send_admin_request(app_handle, |client, access| {
        client
          .get(format!("{COMPANY_API_URL}/profiles"))
          .bearer_auth(access)
      }),
    );
    let users_response = users_response?;
    let profiles_response = profiles_response?;
    if !users_response.status().is_success() {
      return Err(Self::admin_response_error(users_response, "COMPANY_ADMIN_REQUEST_FAILED").await);
    }
    if !profiles_response.status().is_success() {
      return Err(
        Self::admin_response_error(profiles_response, "COMPANY_ADMIN_REQUEST_FAILED").await,
      );
    }
    let users = users_response
      .json::<Vec<CompanyAdminUser>>()
      .await
      .map_err(|_| serde_json::json!({ "code": "COMPANY_ADMIN_INVALID_RESPONSE" }).to_string())?;
    let profiles = profiles_response
      .json::<Vec<CompanyManagedProfile>>()
      .await
      .map_err(|_| serde_json::json!({ "code": "COMPANY_ADMIN_INVALID_RESPONSE" }).to_string())?;
    Ok(CompanyAdminOverview { users, profiles })
  }

  pub async fn create_admin(
    &self,
    app_handle: &tauri::AppHandle,
    username: &str,
    password: &str,
  ) -> Result<(), String> {
    let body = serde_json::json!({
      "username": username,
      "password": password,
      "role": "admin"
    });
    let response = self
      .send_admin_request(app_handle, |client, access| {
        client
          .post(format!("{COMPANY_API_URL}/users"))
          .bearer_auth(access)
          .json(&body)
      })
      .await?;
    if !response.status().is_success() {
      return Err(Self::admin_response_error(response, "COMPANY_ADMIN_CREATE_FAILED").await);
    }
    Ok(())
  }

  pub async fn set_admin_status(
    &self,
    app_handle: &tauri::AppHandle,
    user_id: &str,
    active: bool,
  ) -> Result<(), String> {
    let body = serde_json::json!({ "active": active });
    let response = self
      .send_admin_request(app_handle, |client, access| {
        client
          .patch(format!("{COMPANY_API_URL}/users/{user_id}/status"))
          .bearer_auth(access)
          .json(&body)
      })
      .await?;
    if !response.status().is_success() {
      return Err(Self::admin_response_error(response, "COMPANY_ADMIN_STATUS_FAILED").await);
    }
    Ok(())
  }

  pub async fn reset_admin_password(
    &self,
    app_handle: &tauri::AppHandle,
    user_id: &str,
    password: &str,
  ) -> Result<(), String> {
    let body = serde_json::json!({ "password": password });
    let response = self
      .send_admin_request(app_handle, |client, access| {
        client
          .put(format!("{COMPANY_API_URL}/users/{user_id}/password"))
          .bearer_auth(access)
          .json(&body)
      })
      .await?;
    if !response.status().is_success() {
      return Err(Self::admin_response_error(response, "COMPANY_ADMIN_PASSWORD_FAILED").await);
    }
    Ok(())
  }

  pub async fn batch_transfer_profiles(
    &self,
    app_handle: &tauri::AppHandle,
    profile_ids: Vec<String>,
    target_user_id: &str,
  ) -> Result<usize, String> {
    let body = serde_json::json!({
      "profileIds": profile_ids,
      "targetUserId": target_user_id
    });
    let response = self
      .send_admin_request(app_handle, |client, access| {
        client
          .post(format!("{COMPANY_API_URL}/profiles/batch-transfer"))
          .bearer_auth(access)
          .json(&body)
      })
      .await?;
    if !response.status().is_success() {
      return Err(Self::admin_response_error(response, "COMPANY_BATCH_TRANSFER_FAILED").await);
    }
    let result = response
      .json::<CompanyBatchTransferResponse>()
      .await
      .map_err(|_| serde_json::json!({ "code": "COMPANY_ADMIN_INVALID_RESPONSE" }).to_string())?;
    if result.target_user_id != target_user_id || result.profile_ids.len() != result.updated {
      return Err(serde_json::json!({ "code": "COMPANY_ADMIN_INVALID_RESPONSE" }).to_string());
    }
    let _ = self.visible_profile_ids(app_handle).await;
    let _ = crate::events::emit("profiles-changed", ());
    Ok(result.updated)
  }

  pub async fn register_profile(
    &self,
    app_handle: &tauri::AppHandle,
    profile_id: &str,
    name: &str,
    browser_version: &str,
  ) -> Result<(), String> {
    if !self.is_logged_in().await {
      return Ok(());
    }
    let access = self.get_or_refresh_access_token(app_handle).await?;
    let url = format!("{COMPANY_API_URL}/profiles");
    let body = serde_json::json!({
      "id": profile_id,
      "name": name,
      "browserVersion": browser_version,
    });
    let response = self
      .client
      .post(&url)
      .bearer_auth(&access)
      .json(&body)
      .send()
      .await
      .map_err(|e| format!("Failed to register company profile: {e}"))?;
    if response.status().is_success() {
      let _ = self.visible_profile_ids(app_handle).await;
      let _ = crate::events::emit("profiles-changed", ());
      return Ok(());
    }
    if response.status() != reqwest::StatusCode::BAD_REQUEST {
      return Err(format!(
        "Failed to register company profile ({})",
        response.status()
      ));
    }
    let update = self
      .client
      .patch(format!("{url}/{profile_id}"))
      .bearer_auth(access)
      .json(&body)
      .send()
      .await
      .map_err(|e| format!("Failed to update company profile: {e}"))?;
    if !update.status().is_success() {
      return Err(format!(
        "Failed to update company profile ({})",
        update.status()
      ));
    }
    let _ = self.visible_profile_ids(app_handle).await;
    let _ = crate::events::emit("profiles-changed", ());
    Ok(())
  }

  pub async fn soft_delete_profile(
    &self,
    app_handle: &tauri::AppHandle,
    profile_id: &str,
  ) -> Result<(), String> {
    if !self.is_logged_in().await {
      return Ok(());
    }
    let state = self
      .state()
      .await
      .ok_or_else(|| "Not logged in".to_string())?;
    if state.user.team_role.as_deref() != Some("super_admin") {
      return Err("Only a super administrator can delete company profiles".to_string());
    }
    let access = self.get_or_refresh_access_token(app_handle).await?;
    let response = self
      .client
      .delete(format!("{COMPANY_API_URL}/profiles/{profile_id}"))
      .bearer_auth(access)
      .send()
      .await
      .map_err(|e| format!("Failed to delete company profile: {e}"))?;
    if !response.status().is_success() {
      let status = response.status();
      let body = response.text().await.unwrap_or_default();
      return Err(format!(
        "Failed to delete company profile ({status}): {body}"
      ));
    }
    let _ = self.visible_profile_ids(app_handle).await;
    Ok(())
  }

  pub async fn is_logged_in(&self) -> bool {
    self.state.lock().await.is_some() && Self::access_token().ok().flatten().is_some()
  }

  pub async fn state(&self) -> Option<CloudAuthState> {
    self.state.lock().await.clone()
  }

  pub async fn offline_authorized(&self) -> bool {
    let Some(state) = self.state().await else {
      return false;
    };
    chrono::DateTime::parse_from_rfc3339(&state.logged_in_at)
      .map(|at| {
        Utc::now()
          .signed_duration_since(at.with_timezone(&Utc))
          .num_days()
          < 7
      })
      .unwrap_or(false)
  }

  pub async fn offline_profile_authorized(&self, profile_id: &str) -> bool {
    self
      .cached_profile_ids()
      .await
      .is_some_and(|profile_ids| profile_ids.contains(profile_id))
  }

  async fn cached_profile_ids(&self) -> Option<HashSet<String>> {
    if !self.offline_authorized().await {
      return None;
    }
    let Ok(content) = std::fs::read_to_string(Self::profile_access_path()) else {
      return None;
    };
    let Ok(cache) = serde_json::from_str::<CompanyProfileAccessCache>(&content) else {
      return None;
    };
    let fresh = chrono::DateTime::parse_from_rfc3339(&cache.checked_at)
      .map(|checked| {
        Utc::now()
          .signed_duration_since(checked.with_timezone(&Utc))
          .num_days()
          < 7
      })
      .unwrap_or(false);
    fresh.then_some(cache.profile_ids)
  }

  pub async fn logout(&self, app_handle: &tauri::AppHandle) -> Result<(), String> {
    if let Ok(Some(access)) = Self::load_token("company-access") {
      let refresh = Self::load_token("company-refresh").ok().flatten();
      let _ = self
        .client
        .post(format!("{COMPANY_API_URL}/auth/logout"))
        .bearer_auth(access)
        .json(&serde_json::json!({ "refreshToken": refresh }))
        .send()
        .await;
    }
    Self::delete_token("company-access");
    Self::delete_token("company-refresh");
    let _ = std::fs::remove_file(Self::state_path());
    let _ = std::fs::remove_file(Self::profile_access_path());
    SettingsManager::instance()
      .save_sync_server_url(None)
      .map_err(|e| e.to_string())?;
    SettingsManager::instance()
      .remove_sync_token(app_handle)
      .await
      .map_err(|e| e.to_string())?;
    *self.state.lock().await = None;
    crate::team_lock::PROFILE_LOCK.disconnect().await;
    let _ = crate::events::emit_empty("cloud-auth-expired");
    let _ = crate::events::emit("profiles-changed", ());
    Ok(())
  }

  pub async fn start_refresh_loop(app_handle: tauri::AppHandle) {
    loop {
      if COMPANY_AUTH.is_logged_in().await {
        if let Err(error) = COMPANY_AUTH.refresh(&app_handle).await {
          log::warn!("Company access-token refresh failed: {error}");
          if error.contains("(401)") || error.contains("(403)") {
            let _ = COMPANY_AUTH.logout(&app_handle).await;
          }
        }
      }
      tokio::time::sleep(std::time::Duration::from_secs(10 * 60)).await;
    }
  }
}

#[tauri::command]
pub async fn company_login(
  app_handle: tauri::AppHandle,
  username: String,
  password: String,
) -> Result<CloudAuthState, String> {
  COMPANY_AUTH.login(&app_handle, &username, &password).await
}

#[tauri::command]
pub async fn company_get_user() -> Result<Option<CloudAuthState>, String> {
  Ok(COMPANY_AUTH.state().await)
}

#[tauri::command]
pub async fn company_logout(app_handle: tauri::AppHandle) -> Result<(), String> {
  COMPANY_AUTH.logout(&app_handle).await
}

#[tauri::command]
pub async fn company_refresh(app_handle: tauri::AppHandle) -> Result<CloudUser, String> {
  COMPANY_AUTH.refresh(&app_handle).await?;
  COMPANY_AUTH
    .state()
    .await
    .map(|state| state.user)
    .ok_or_else(|| "Not logged in".to_string())
}

#[tauri::command]
pub async fn company_get_admin_overview(
  app_handle: tauri::AppHandle,
) -> Result<CompanyAdminOverview, String> {
  COMPANY_AUTH.admin_overview(&app_handle).await
}

#[tauri::command]
pub async fn company_create_admin(
  app_handle: tauri::AppHandle,
  username: String,
  password: String,
) -> Result<(), String> {
  COMPANY_AUTH
    .create_admin(&app_handle, &username, &password)
    .await
}

#[tauri::command]
pub async fn company_set_admin_status(
  app_handle: tauri::AppHandle,
  user_id: String,
  active: bool,
) -> Result<(), String> {
  COMPANY_AUTH
    .set_admin_status(&app_handle, &user_id, active)
    .await
}

#[tauri::command]
pub async fn company_reset_admin_password(
  app_handle: tauri::AppHandle,
  user_id: String,
  password: String,
) -> Result<(), String> {
  COMPANY_AUTH
    .reset_admin_password(&app_handle, &user_id, &password)
    .await
}

#[tauri::command]
pub async fn company_batch_transfer_profiles(
  app_handle: tauri::AppHandle,
  profile_ids: Vec<String>,
  target_user_id: String,
) -> Result<usize, String> {
  COMPANY_AUTH
    .batch_transfer_profiles(&app_handle, profile_ids, &target_user_id)
    .await
}
