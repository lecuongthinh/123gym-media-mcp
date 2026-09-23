import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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

export class CompositeCredentialProvider {
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
    if (!accessToken) throw new Error(`HighLevel credential is not configured for connection ${connection.connection_id}.`);
    return { accessToken, locationId: connection.location_id, scopes: connection.scopes || [], expiresAt: connection.expires_at || null };
  }

  async #encryptedAccess(connection) {
    if (!connection.encrypted_payload) throw new Error(`Encrypted HighLevel credential is not configured for connection ${connection.connection_id}.`);
    let credential = decryptCredential(connection.encrypted_payload, this.env);
    const expiresAt = credential.expires_at ? new Date(credential.expires_at) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now() + 60_000) {
      credential = await this.#refreshHighLevel(connection, credential);
    }
    if (!credential.access_token || credential.location_id !== connection.location_id) throw new Error("Credential location binding mismatch.");
    return {
      accessToken: credential.access_token,
      locationId: credential.location_id,
      scopes: credential.scope ? String(credential.scope).split(/\s+/).filter(Boolean) : connection.scopes || [],
      expiresAt: credential.expires_at || null
    };
  }

  async #refreshHighLevel(connection, credential) {
    if (!credential.refresh_token) throw new Error("HighLevel OAuth refresh token is unavailable.");
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
    if (!response.ok) throw new Error(`HighLevel OAuth refresh failed (${response.status}).`);
    const next = {
      ...credential,
      access_token: body.access_token,
      refresh_token: body.refresh_token || credential.refresh_token,
      scope: body.scope || credential.scope,
      location_id: body.locationId || credential.location_id,
      expires_at: new Date(Date.now() + Number(body.expires_in || 86400) * 1000).toISOString()
    };
    if (next.location_id !== connection.location_id) throw new Error("Refreshed credential location binding mismatch.");
    await this.repository.updateEncryptedCredential(connection.credential_id, encryptCredential(next, this.env), next.expires_at);
    return next;
  }
}
