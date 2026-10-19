import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mintLocationToken } from "./highlevel-location-token.js";

function encryptionKey(env = process.env) {
  const encoded = env.TENANT_CREDENTIAL_ENCRYPTION_KEY;
  if (!encoded) throw new Error("TENANT_CREDENTIAL_ENCRYPTION_KEY is required for encrypted credentials.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("TENANT_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

export function encryptCredential(value, env = process.env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]);
}

export function decryptCredential(payload, env = process.env) {
  const data = Buffer.from(payload || []);
  if (data.length < 30 || data[0] !== 1) throw new Error("Encrypted credential payload is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(env), data.subarray(1, 13));
  decipher.setAuthTag(data.subarray(13, 29));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]).toString("utf8"));
}

export const CREDENTIAL_REFRESH_FAILED = "CREDENTIAL_REFRESH_FAILED";
export const RECONNECT_MESSAGE =
  "Kết nối với HighLevel đã hết hạn hoặc bị thu hồi. Hãy chạy connect_social_account để kết nối lại, sau đó thử lại.";

// Thrown when HighLevel permanently rejects a refresh (or no refresh token is
// left). `message` is safe to show to an agent: it never contains a token.
export class CredentialRefreshError extends Error {
  constructor(status) {
    super(RECONNECT_MESSAGE);
    this.name = "CredentialRefreshError";
    this.code = CREDENTIAL_REFRESH_FAILED;
    this.status = status ?? null;
  }
}

const PERMANENT_REFRESH_STATUSES = new Set([400, 401, 403]);

function isFresh(credential) {
  const expiresAt = credential?.expires_at ? new Date(credential.expires_at) : null;
  return !expiresAt || expiresAt.getTime() > Date.now() + 60_000;
}

export class CompositeCredentialProvider {
  // credential_id -> in-flight refresh promise (single-flight within this process).
  #inflight = new Map();

  constructor({ env = process.env, repository, fetchImpl = globalThis.fetch } = {}) {
    this.env = env;
    this.repository = repository;
    this.fetch = fetchImpl;
  }

  async getAccess(connection) {
    if (!connection) throw new Error("Connection is required.");
    if (connection.secret_backend === "environment") return this.#environmentAccess(connection);
    if (connection.secret_backend === "encrypted_database") return this.#encryptedAccess(connection);
    throw new Error("Unsupported credential backend.");
  }

  #environmentAccess(connection) {
    const match = /^env:\/\/([A-Z][A-Z0-9_]*)$/.exec(connection.secret_ref || "");
    if (!match) throw new Error("Invalid environment credential reference.");
    const accessToken = this.env[match[1]];
    if (!accessToken) throw new Error(`Credential is not configured for connection ${connection.connection_id}.`);
    return { accessToken, locationId: connection.location_id, scopes: connection.scopes || [], expiresAt: connection.expires_at || null };
  }

  async #encryptedAccess(connection) {
    if (!connection.encrypted_payload) throw new Error(`Encrypted credential is not configured for connection ${connection.connection_id}.`);
    let credential = decryptCredential(connection.encrypted_payload, this.env);
    const expiresAt = credential.expires_at ? new Date(credential.expires_at) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now() + 60_000) {
      credential = await this.#refreshSingleFlight(connection, credential);
    }
    if (!credential.access_token || credential.location_id !== connection.location_id) throw new Error("Credential location binding mismatch.");
    return {
      accessToken: credential.access_token,
      locationId: credential.location_id,
      scopes: credential.scope ? String(credential.scope).split(/\s+/).filter(Boolean) : connection.scopes || [],
      expiresAt: credential.expires_at || null
    };
  }

  // HighLevel rotates refresh tokens, so two concurrent refreshes with the same
  // token can invalidate the whole chain. Within one process the callers share a
  // single promise; across instances the repository lock (SELECT ... FOR UPDATE)
  // serialises them and hands back the latest stored credential to re-check.
  async #refreshSingleFlight(connection, credential) {
    const key = connection.credential_id || connection.connection_id;
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#refreshLocked(connection, credential)
        .finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  async #refreshLocked(connection, credential) {
    try {
      if (typeof this.repository?.withCredentialLock !== "function") {
        return await this.#refreshHighLevel(connection, credential);
      }
      return await this.repository.withCredentialLock(connection.credential_id, async ({ encryptedPayload, save }) => {
        // Re-read after taking the lock: another instance may have refreshed already.
        const latest = encryptedPayload ? decryptCredential(encryptedPayload, this.env) : credential;
        if (isFresh(latest)) return latest;
        return this.#refreshHighLevel(connection, latest, save);
      });
    } catch (error) {
      if (error instanceof CredentialRefreshError) await this.#recordRefreshFailure(connection, error);
      throw error;
    }
  }

  async #recordRefreshFailure(connection, error) {
    // Best effort: a failure here must never mask the actionable error.
    try { await this.repository?.markConnectionError?.(connection.connection_id); } catch { /* ignore */ }
    try {
      await this.repository?.recordAuditEvent?.({
        tenantId: connection.tenant_id || null,
        action: "credential.refresh_failed",
        result: "failure",
        metadata: { connectionId: connection.connection_id, locationId: connection.location_id, httpStatus: error.status }
      });
    } catch { /* ignore */ }
  }

  async #persist(connection, next, save) {
    const payload = encryptCredential(next, this.env);
    if (save) await save(payload, next.expires_at);
    else await this.repository.updateEncryptedCredential(connection.credential_id, payload, next.expires_at);
  }

  async #refreshHighLevel(connection, credential, save) {
    if (credential.auth_mode === "company") return this.#refreshCompanyLocation(connection, credential, save);
    if (!credential.refresh_token) throw new CredentialRefreshError(null);
    const response = await this.fetch("https://services.leadconnectorhq.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
      body: new URLSearchParams({
        client_id: this.env.HIGHLEVEL_CLIENT_ID || "",
        client_secret: this.env.HIGHLEVEL_CLIENT_SECRET || "",
        grant_type: "refresh_token",
        refresh_token: credential.refresh_token,
        user_type: "Location"
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (PERMANENT_REFRESH_STATUSES.has(response.status)) throw new CredentialRefreshError(response.status);
      throw new Error(`OAuth refresh failed (${response.status}).`);
    }
    const next = {
      ...credential,
      access_token: body.access_token,
      refresh_token: body.refresh_token || credential.refresh_token,
      scope: body.scope || credential.scope,
      location_id: body.locationId || credential.location_id,
      expires_at: new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString()
    };
    if (next.location_id !== connection.location_id) throw new Error("Refreshed credential location binding mismatch.");
    await this.#persist(connection, next, save);
    return next;
  }

  // Company-scoped connections (see highlevel-location-token.js for why
  // these exist): refresh the agency-level token, then re-mint a fresh
  // location-scoped access token from it. There is no location-level
  // refresh_token to rotate -- the location token is always re-derived.
  async #refreshCompanyLocation(connection, credential, save) {
    if (!credential.company_refresh_token) throw new CredentialRefreshError(null);
    const response = await this.fetch("https://services.leadconnectorhq.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "v3" },
      body: new URLSearchParams({
        client_id: this.env.HIGHLEVEL_CLIENT_ID || "",
        client_secret: this.env.HIGHLEVEL_CLIENT_SECRET || "",
        grant_type: "refresh_token",
        refresh_token: credential.company_refresh_token,
        user_type: "Company"
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (PERMANENT_REFRESH_STATUSES.has(response.status)) throw new CredentialRefreshError(response.status);
      throw new Error(`OAuth company refresh failed (${response.status}).`);
    }
    const minted = await mintLocationToken({
      companyAccessToken: body.access_token,
      companyId: credential.company_id,
      locationId: credential.location_id,
      fetchImpl: this.fetch
    });
    const next = {
      ...credential,
      company_refresh_token: body.refresh_token || credential.company_refresh_token,
      access_token: minted.accessToken,
      expires_at: new Date(Date.now() + minted.expiresIn * 1000).toISOString()
    };
    if (next.location_id !== connection.location_id) throw new Error("Refreshed credential location binding mismatch.");
    await this.#persist(connection, next, save);
    return next;
  }
}
