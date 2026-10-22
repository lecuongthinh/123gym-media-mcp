// Phiên đăng nhập cho các module NGOÀI app gốc (app gốc dùng platform.sessions gắn với danh sách nhân viên của
// tenant). Module không có danh sách nhân viên riêng — quyền lấy thẳng từ gói SSO mà GHL ký cho Custom Page.
import crypto from "crypto";
import { platformQuery } from "./db.mjs";

let ready;
const ensure = () => (ready ||= platformQuery(`create table if not exists platform.module_sessions (
  id text primary key, app_key text not null, location_id text not null, email text, name text, role text,
  created_at timestamptz not null default now()
)`));

export async function createModuleSession(appKey, { locationId, email, name, role }) {
  await ensure();
  await platformQuery("delete from platform.module_sessions where created_at < now() - interval '2 days'");
  const id = crypto.randomBytes(24).toString("hex");
  await platformQuery("insert into platform.module_sessions (id, app_key, location_id, email, name, role) values ($1,$2,$3,$4,$5,$6)", [id, appKey, locationId, email || null, name || null, role]);
  return id;
}
// Phiên chỉ hợp lệ cho ĐÚNG app đã cấp — token của module này không dùng được ở module khác.
export async function getModuleSession(appKey, id) {
  if (!id) return null;
  await ensure();
  const r = await platformQuery("select location_id, email, name, role from platform.module_sessions where id=$1 and app_key=$2", [id, appKey]);
  const x = r.rows[0];
  return x ? { locationId: x.location_id, email: x.email, name: x.name, role: x.role } : null;
}
