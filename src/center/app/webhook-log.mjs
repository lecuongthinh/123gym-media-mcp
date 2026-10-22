// Nhật ký thô cho mọi webhook GHL gửi tới /webhooks/ghl — dùng chung cho mọi tenant (không thuộc schema
// riêng của khách nào) vì 1 webhook đến TRƯỚC KHI biết chắc locationId có hợp lệ hay không, và vì đây chỉ là
// nhật ký quan sát/debug, không phải dữ liệu nghiệp vụ của khách hàng nào.
import { platformQuery } from "./db.mjs";

let ready;
async function ensureTable() {
  ready ||= (async () => {
    await platformQuery(`create table if not exists platform.webhook_log (
      id bigserial primary key,
      type text,
      location_id text,
      headers jsonb not null,
      body jsonb,
      received_at timestamptz not null default now()
    )`);
    // Thêm sau (bảng đã có từ trước) — "create table if not exists" không tự thêm cột mới vào bảng đã tồn tại.
    await platformQuery(`alter table platform.webhook_log add column if not exists signature_valid boolean`);
  })();
  return ready;
}

export async function logWebhook({ type, locationId, headers, body, signatureValid }) {
  await ensureTable();
  await platformQuery(
    `insert into platform.webhook_log (type, location_id, headers, body, signature_valid) values ($1, $2, $3, $4, $5)`,
    [type || null, locationId || null, JSON.stringify(headers || {}), body !== undefined ? JSON.stringify(body) : null, signatureValid ?? null]
  );
}

export async function listRecentWebhookLogs(limit = 20, type) {
  await ensureTable();
  const r = type
    ? await platformQuery(`select id, type, location_id, headers, body, received_at from platform.webhook_log where type = $1 order by id desc limit $2`, [type, limit])
    : await platformQuery(`select id, type, location_id, headers, body, received_at from platform.webhook_log order by id desc limit $1`, [limit]);
  return r.rows;
}
