// Mã hoá/giải mã credential GHL của từng tenant trước khi lưu vào Postgres — dùng cho token OAuth (đổi mới
// khi hết hạn, không được lưu thô như PIT tĩnh). AES-256-GCM, cùng cách làm đã kiểm chứng ở "Uplifting Social
// AI" (`123gym-media-mcp/src/credential-provider.js`) — không tự nghĩ ra sơ đồ mã hoá mới.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "fs";

const ENV_PATH = new URL("./.env", import.meta.url);
const env = {
  ...(fs.existsSync(ENV_PATH)
    ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
    : {}),
  ...process.env,
};

function encryptionKey() {
  // CENTER_TENANT_CREDENTIAL_ENCRYPTION_KEY ưu tiên trước — tránh dùng NHẦM khoá của 1 app khác khi chạy
  // chung tiến trình (vd Uplifting Social AI cũng có biến TENANT_CREDENTIAL_ENCRYPTION_KEY của riêng nó).
  const encoded = env.CENTER_TENANT_CREDENTIAL_ENCRYPTION_KEY || env.TENANT_CREDENTIAL_ENCRYPTION_KEY;
  if (!encoded) throw new Error("Thiếu TENANT_CREDENTIAL_ENCRYPTION_KEY (hoặc CENTER_TENANT_CREDENTIAL_ENCRYPTION_KEY) trong .env — base64 của 32 byte ngẫu nhiên (chạy: openssl rand -base64 32)");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("TENANT_CREDENTIAL_ENCRYPTION_KEY phải là base64 của đúng 32 byte");
  return key;
}

export function encryptCredential(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]); // byte 0 = version, cho phép đổi sơ đồ sau này mà không vỡ dữ liệu cũ
}

export function decryptCredential(payload) {
  const data = Buffer.from(payload || []);
  if (data.length < 30 || data[0] !== 1) throw new Error("Credential đã mã hoá không hợp lệ hoặc sai định dạng.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(1, 13));
  decipher.setAuthTag(data.subarray(13, 29));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]).toString("utf8"));
}
