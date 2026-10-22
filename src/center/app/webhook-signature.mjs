// Kiểm tra chữ ký webhook GHL (header X-GHL-Signature, thuật toán Ed25519) — xác nhận request THẬT SỰ đến từ
// GHL, không phải ai đó gọi giả vào /webhooks/ghl để ép app đọc lại dữ liệu liên tục. Khoá công khai lấy từ
// tài liệu chính thức (Marketplace App > Advanced Settings > Webhooks > mục Security), không đổi theo app.
// Chữ ký ký trên ĐÚNG BYTE THÔ của phần thân request — không được parse JSON rồi stringify lại trước khi
// kiểm tra, vì thứ tự field/khoảng trắng có thể khác bản gốc và làm chữ ký đúng bị coi là sai.
import crypto from "crypto";

const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

export function verifyGhlSignature(rawBody, signatureB64) {
  if (!signatureB64) return false;
  try {
    return crypto.verify(null, Buffer.from(rawBody, "utf8"), GHL_ED25519_PUBLIC_KEY, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
