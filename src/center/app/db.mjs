// Kết nối Postgres dùng chung (Supabase project "lecuongthinh" — cùng project với growthLEADERs/uplifting
// nhưng mỗi khách hàng của app này có 1 SCHEMA RIÊNG, không đụng bảng của họ lẫn của nhau).
//
// Đợt "multi-tenant" (chuẩn bị cho khách thứ 2 trở đi dùng thật, tự phục vụ): trước đây mọi hàm ở đây hardcode
// schema "candy_english" ngay trong câu SQL — đúng cho lúc chỉ có 1 khách. Giờ MỌI hàm theo-khách-hàng nhận
// thêm tham số `schema` (tên schema Postgres của khách đó), và có thêm 1 khu vực HOÀN TOÀN RIÊNG — schema
// "platform" — không thuộc về khách hàng nào, chỉ để BIẾT có những khách hàng nào (bảng `tenants`) và ai đang
// đăng nhập (bảng `sessions`, dùng chung cho mọi khách vì token phải tự tra ra được thuộc khách nào TRƯỚC KHI
// biết cần đọc schema nào — không thể phân mảnh session theo từng schema riêng được).
import pg from "pg";
const { Pool } = pg;

const ENV_PATH = new URL("./.env", import.meta.url);
import fs from "fs";
const fileEnv = fs.existsSync(ENV_PATH)
  ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
  : {};
// CENTER_DATABASE_URL ưu tiên trước DATABASE_URL thường — cần thiết khi chạy CHUNG tiến trình với 1 app
// khác cũng tự nhận biến DATABASE_URL (vd Uplifting Social AI) để không bị đọc nhầm sang database của app
// kia. Deploy riêng (như trước giờ) chỉ cần đặt DATABASE_URL như cũ, không cần đổi gì.
const DATABASE_URL = process.env.CENTER_DATABASE_URL || process.env.DATABASE_URL || fileEnv.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Thiếu DATABASE_URL trong .env — chuỗi kết nối Postgres (Supabase > Connect)");

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Tên schema là 1 ĐỊNH DANH (identifier) chèn thẳng vào chuỗi SQL — Postgres không cho tham số hoá tên bảng/
// schema như giá trị thường ($1, $2...). Mọi schema đến từ đâu đó KHÔNG do chính code này gõ tay (ví dụ đọc
// từ bảng tenants) đều phải qua đây trước khi chèn vào SQL, để 1 tên schema sai/ác ý không thể chèn SQL lạ.
const SCHEMA_RE = /^[a-z][a-z0-9_]{1,50}$/;
function assertSchema(name) {
  if (!SCHEMA_RE.test(String(name || ""))) throw new Error(`Tên schema không hợp lệ: ${name}`);
  return name;
}

// --- Hạ tầng dùng chung cho MỌI khách hàng (schema "platform") --------------------------------------------
// Tạo 1 lần, idempotent (IF NOT EXISTS) — an toàn để gọi lại mỗi lần server khởi động.
async function ensurePlatformSchema() {
  await pool.query("create schema if not exists platform");
  await pool.query(`create table if not exists platform.tenants (
    location_id text primary key,
    schema_name text not null unique,
    ghl_pit text not null,
    brand_name text not null,
    brand_mark text not null,
    org_label text not null,
    menu_label text not null,
    created_at timestamptz not null default now()
  )`);
  // Đợt "khách tự cài qua OAuth": trước đây 1 tenant CHỈ dùng PIT tĩnh (ghl_pit). Giờ thêm 1 loại credential
  // thứ 2 — token OAuth (hết hạn, cần refresh), mã hoá trước khi lưu (xem credential-crypto.mjs). 2 cột mới
  // đều nullable/có default nên thêm vào bảng cũ không ảnh hưởng tenant PIT đang chạy (candy_english).
  await pool.query(`alter table platform.tenants add column if not exists credential_type text not null default 'pit' check (credential_type in ('pit','oauth'))`);
  await pool.query(`alter table platform.tenants add column if not exists encrypted_credential bytea`);
  await pool.query(`alter table platform.tenants alter column ghl_pit drop not null`);
  // Session dùng CHUNG 1 bảng cho mọi khách (không nằm trong schema riêng của khách) — xem giải thích ở đầu file.
  await pool.query(`create table if not exists platform.sessions (
    id text primary key,
    location_id text not null,
    email text not null,
    name text,
    role text,
    created_at timestamptz not null default now()
  )`);
}
const platformReady = ensurePlatformSchema();

// Truy vấn tự do vào schema "platform" cho các module mới (ghl-company.mjs, zalo-oa.mjs) — các module đó tự
// tạo bảng của mình (create table if not exists) nên không cần sửa ensurePlatformSchema() mỗi lần thêm bảng.
export async function platformQuery(sql, params = []) {
  await platformReady;
  return pool.query(sql, params);
}

// --- Tenants (bảng điều khiển — biết có những khách hàng nào, khách nào ứng với location GHL nào) ---------
export async function getTenantByLocation(locationId) {
  await platformReady;
  const r = await pool.query("select location_id, schema_name, ghl_pit, credential_type, encrypted_credential, brand_name, brand_mark, org_label, menu_label from platform.tenants where location_id = $1", [locationId]);
  return r.rows[0] || null;
}
export async function listTenants() {
  await platformReady;
  const r = await pool.query("select location_id, schema_name, brand_name, brand_mark, org_label, menu_label, created_at from platform.tenants order by created_at asc");
  return r.rows; // KHÔNG trả ghl_pit ra ngoài hàm này — tránh lộ token qua bất kỳ route liệt kê tenants nào lỡ dùng nhầm hàm này sau này.
}
export async function upsertTenant({ locationId, schemaName, ghlPit, brandName, brandMark, orgLabel, menuLabel }) {
  await platformReady;
  assertSchema(schemaName);
  if (!locationId) throw new Error("Cần locationId");
  const r = await pool.query(
    `insert into platform.tenants (location_id, schema_name, ghl_pit, brand_name, brand_mark, org_label, menu_label)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (location_id) do update set schema_name=excluded.schema_name, ghl_pit=excluded.ghl_pit,
       brand_name=excluded.brand_name, brand_mark=excluded.brand_mark, org_label=excluded.org_label, menu_label=excluded.menu_label
     returning location_id, schema_name, brand_name, brand_mark, org_label, menu_label`,
    [locationId, schemaName, ghlPit, brandName, brandMark, orgLabel, menuLabel]
  );
  return r.rows[0];
}

// Đăng ký 1 tenant mới từ luồng OAuth (khách tự bấm Install, không ai gõ PIT tay) — khác upsertTenant() ở
// chỗ credential là token mã hoá (encryptedCredential, đã mã hoá từ trước bằng credential-crypto.mjs) thay
// vì PIT dạng chữ thường. Nếu location đã có tenant rồi (cài lại/kết nối lại), chỉ cập nhật credential, GIỮ
// NGUYÊN schema/thương hiệu đã có — không tạo tenant trùng.
export async function upsertOAuthTenant({ locationId, schemaName, encryptedCredential, brandName, brandMark, orgLabel, menuLabel }) {
  await platformReady;
  assertSchema(schemaName);
  if (!locationId) throw new Error("Cần locationId");
  const r = await pool.query(
    `insert into platform.tenants (location_id, schema_name, ghl_pit, credential_type, encrypted_credential, brand_name, brand_mark, org_label, menu_label)
     values ($1,$2,null,'oauth',$3,$4,$5,$6,$7)
     on conflict (location_id) do update set encrypted_credential=excluded.encrypted_credential, credential_type='oauth'
     returning location_id, schema_name, brand_name, brand_mark, org_label, menu_label`,
    [locationId, schemaName, encryptedCredential, brandName, brandMark, orgLabel, menuLabel]
  );
  return r.rows[0];
}
export async function updateTenantCredential(locationId, encryptedCredential) {
  await platformReady;
  await pool.query("update platform.tenants set encrypted_credential = $2 where location_id = $1", [locationId, encryptedCredential]);
}

// Tạo schema + 2 bảng con (kv_store, staff) cho 1 khách hàng MỚI — idempotent, gọi lại không lỗi nếu đã có.
// Đây là toàn bộ phần "hạ tầng dữ liệu" mà 1 khách hàng mới cần, tách khỏi upsertTenant() để script khởi
// tạo (provision-tenant.mjs) có thể gọi trước khi biết đủ mọi chi tiết thương hiệu.
export async function ensureTenantSchema(schemaName) {
  assertSchema(schemaName);
  await pool.query(`create schema if not exists ${schemaName}`);
  await pool.query(`create table if not exists ${schemaName}.kv_store (
    key text primary key, value jsonb not null, updated_at timestamptz not null default now()
  )`);
  await pool.query(`create table if not exists ${schemaName}.staff (
    email text primary key, name text not null default '', role text not null default 'staff', added_at timestamptz not null default now()
  )`);
}

// --- Kho key-value theo từng khách hàng (thay cho các file overlay/config nhỏ) -----------------------------
export async function kvGet(schema, key, fallback) {
  assertSchema(schema);
  const r = await pool.query(`select value from ${schema}.kv_store where key = $1`, [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}
export async function kvSet(schema, key, value) {
  assertSchema(schema);
  await pool.query(
    `insert into ${schema}.kv_store (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

// --- Nhân viên theo từng khách hàng (đăng nhập/phân quyền) --------------------------------------------------
const norm = (email) => String(email || "").trim().toLowerCase();

export async function findStaff(schema, email) {
  assertSchema(schema);
  const r = await pool.query(`select email, name, role, added_at from ${schema}.staff where email = $1`, [norm(email)]);
  return r.rows[0] || null;
}
export async function listStaff(schema) {
  assertSchema(schema);
  const r = await pool.query(`select email, name, role, added_at from ${schema}.staff order by added_at asc`);
  return r.rows;
}
export async function addStaff(schema, { email, name, role }) {
  assertSchema(schema);
  email = norm(email);
  if (!email || !email.includes("@")) throw new Error("Email không hợp lệ");
  if (await findStaff(schema, email)) throw new Error("Email này đã có trong danh sách nhân viên");
  const r = await pool.query(
    `insert into ${schema}.staff (email, name, role) values ($1, $2, $3) returning email, name, role, added_at`,
    [email, (name || "").trim() || email, role === "admin" ? "admin" : "staff"]
  );
  return r.rows[0];
}
export async function setStaffRole(schema, email, role) {
  assertSchema(schema);
  const r = await pool.query(
    `update ${schema}.staff set role = $2 where email = $1 returning email, name, role, added_at`,
    [norm(email), role === "admin" ? "admin" : "staff"]
  );
  if (!r.rows[0]) throw new Error("Không tìm thấy nhân viên với email này");
  return r.rows[0];
}
export async function removeStaff(schema, email) {
  assertSchema(schema);
  const r = await pool.query(`delete from ${schema}.staff where email = $1`, [norm(email)]);
  return r.rowCount > 0;
}

// --- Phiên đăng nhập (chung cho mọi khách hàng — xem giải thích platform.sessions ở trên) -------------------
export async function createSession({ locationId, email, name, role }) {
  await platformReady;
  const id = (await import("crypto")).randomBytes(24).toString("hex");
  await pool.query("insert into platform.sessions (id, location_id, email, name, role) values ($1,$2,$3,$4,$5)", [id, locationId, email, name, role]);
  return id;
}
export async function getSession(id) {
  await platformReady;
  if (!id) return null;
  const r = await pool.query("select location_id, email, name, role, created_at from platform.sessions where id = $1", [id]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { locationId: row.location_id, email: row.email, name: row.name, role: row.role, created_at: row.created_at };
}
export async function destroySession(id) {
  await platformReady;
  if (id) await pool.query("delete from platform.sessions where id = $1", [id]);
}
