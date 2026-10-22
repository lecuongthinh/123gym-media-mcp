// Read-only GHL client cho module "Khách hàng" (demo 123 GYM, không đi kèm bản deploy thật — xem
// contactsEnabled ở server.mjs). Trước đây đọc token từ 1 thư mục project KHÁC nằm CẠNH staff-web-demo
// trên máy cục bộ (../123gym-server/.env) — chỉ tồn tại trên máy dev, làm sập server ngay lúc khởi động
// trên Render (không có thư mục đó). Giờ đọc an toàn: thiếu thì bỏ qua thay vì crash, ghlGet lúc đó báo
// lỗi rõ ràng khi THẬT SỰ được gọi, không phải ngay lúc import module.
import fs from "fs";
const ENV_PATH = new URL("../123gym-server/.env", import.meta.url);
const env = fs.existsSync(ENV_PATH)
  ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }))
  : {};
export const LOCATION_ID = env.GHL_LOCATION_ID; // Bạch Đằng
const BASE = env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const H = { Authorization: `Bearer ${env.GHL_PRIVATE_TOKEN}`, Version: env.GHL_API_VERSION || "2021-07-28", Accept: "application/json" };
export async function ghlGet(path) {
  if (!env.GHL_PRIVATE_TOKEN) throw new Error("Module Khách hàng (123 GYM) không có sẵn trên bản deploy này");
  if (!path.startsWith("/")) throw new Error("bad path");
  const r = await fetch(BASE + path, { method: "GET", headers: H });
  if (!r.ok) throw new Error(`GHL GET ${path.split("?")[0]} -> ${r.status}`);
  return r.json();
}

// Used ONLY by ghl-write-guarded.mjs (which enforces the allowlist). Kept separate from ghlGet on purpose.
export async function ghlRequest(method, path, body) {
  if (!["POST", "DELETE"].includes(method)) throw new Error("bad method");
  const r = await fetch(BASE + path, { method, headers: { ...H, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = new Error(`GHL ${method} ${path.replace(/\/contacts\/[^/]+/, "/contacts/<id>")} -> ${r.status}`); e.status = r.status; throw e; }
  return r.status === 204 ? {} : r.json().catch(() => ({}));
}
