// Client GHL cho module service: CRUD object tuỳ chỉnh + liên kết (association) + người dùng. "GHL = tay, app = não":
// mọi quy tắc nằm ở service.mjs/logic.mjs, file này chỉ gọi API. Token do bên ngoài cấp (OAuth của Marketplace app
// ở production, hoặc PIT khi chạy thử cục bộ) — không bao giờ nhận từ trình duyệt.
const BASE = "https://services.leadconnectorhq.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGhl({ locationId, getToken, fetchImpl = globalThis.fetch, cacheMs = 15000, now = () => Date.now() }) {
  const cache = new Map(); // objectKey -> { at, rows }
  let assocCache = null;

  async function call(method, path, body, tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
      const token = await getToken();
      const r = await fetchImpl(BASE + path, { method, headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 429 || r.status >= 500) { last = r.status; await sleep(800 * (i + 1)); continue; }
      const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
      if (!r.ok) { const e = new Error(`GHL ${method} ${path.split("?")[0]} → ${r.status}: ${String(j.message || j.error || text).slice(0, 200)}`); e.status = r.status; throw e; }
      return j;
    }
    const e = new Error(`GHL ${method} ${path.split("?")[0]} → ${last} (đã thử lại ${tries} lần)`); e.status = last; throw e;
  }

  // Liệt kê TOÀN BỘ bản ghi của 1 object (duyệt hết trang). Có cache ngắn + ghi-xuyên (write-through) để vừa nhanh
  // vừa thấy ngay thay đổi của chính mình (search index của GHL trễ vài giây sau khi ghi).
  // Chỉ mục tìm kiếm của GHL trễ vài giây sau khi ghi (bản ghi mới chưa thấy, bản vừa sửa còn giá trị cũ). Vì vậy mọi
  // thay đổi của CHÍNH app được giữ thêm RECENT_MS trong "lớp phủ" và trộn vào kết quả mỗi lần đọc lại — nếu không,
  // làm tươi dữ liệu có thể làm biến mất bản ghi vừa tạo (và sinh phiếu bảo trì trùng).
  const RECENT_MS = 120_000;
  const recent = new Map(); // objectKey -> Map(id -> { rec, at })
  const note = (objectKey, id, rec, props) => {
    const m = recent.get(objectKey) || recent.set(objectKey, new Map()).get(objectKey);
    const prev = m.get(id);
    m.set(id, { rec: { ...(prev?.rec || rec || { id }), properties: { ...(prev?.rec?.properties || rec?.properties || {}), ...(props || {}) } }, at: now() });
  };
  const overlay = (objectKey, rows) => {
    const m = recent.get(objectKey); if (!m) return rows;
    const t = now(); const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [id, x] of [...m]) {
      if (t - x.at > RECENT_MS) { m.delete(id); continue; }
      const r = byId.get(id);
      if (r) byId.set(id, { ...r, properties: { ...(r.properties || {}), ...(x.rec.properties || {}) } }); else byId.set(id, x.rec);
    }
    return [...byId.values()];
  };

  async function listAll(objectKey, { fresh = false } = {}) {
    const hit = cache.get(objectKey);
    if (hit && !fresh && now() - hit.at < cacheMs) return hit.rows;
    const rows = []; const seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const j = await call("POST", `/objects/${objectKey}/records/search`, { locationId, page, pageLimit: 100, query: "" });
      const recs = j.records || [];
      for (const r of recs) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
      if (recs.length < 100 || rows.length >= (j.total ?? Infinity)) break;
    }
    const merged = overlay(objectKey, rows);
    cache.set(objectKey, { at: now(), rows: merged });
    return merged;
  }
  const patchCache = (objectKey, fn) => { const h = cache.get(objectKey); if (h) { h.rows = fn(h.rows); h.at = now(); } };

  // --- cơ hội bán hàng (Opportunities) -----------------------------------------------------------------
  // Tên field tuỳ chỉnh của cơ hội (tiếng Việt) → khoá ngắn dùng trong logic. Đọc theo TÊN vì khoá field do GHL tự sinh.
  const OPP_FIELDS = { "Loại thang": "loai_thang", "Số lượng thang": "so_luong", "Hình thức": "hinh_thuc", "Giai đoạn công trình": "giai_doan_ct", "Đối thủ đang chào": "doi_thu", "Ngày cần bàn giao": "ngay_can_ban_giao" };
  let oppFieldNames = null, oppCache = null;
  async function pipelines() {
    const j = await call("GET", `/opportunities/pipelines?locationId=${locationId}`);
    return (j.pipelines || []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((st) => ({ id: st.id, name: st.name, position: st.position, prob: Number(st.stageWinProbability) || 0 })).sort((a, b) => a.position - b.position) }));
  }
  async function opportunities() {
    if (oppCache && now() - oppCache.at < cacheMs) return oppCache.rows;
    if (!oppFieldNames) { try { const f = await call("GET", `/locations/${locationId}/customFields?model=opportunity`); oppFieldNames = Object.fromEntries((f.customFields || []).map((x) => [x.id, OPP_FIELDS[x.name]]).filter((x) => x[1])); } catch { oppFieldNames = {}; } }
    const rows = [], seen = new Set();
    for (let page = 1; page <= 30; page++) {
      const j = await call("GET", `/opportunities/search?location_id=${locationId}&limit=100&page=${page}`);
      const list = j.opportunities || [];
      for (const o of list) {
        if (seen.has(o.id)) continue; seen.add(o.id);
        const f = {}; for (const cf of o.customFields || []) { const k = oppFieldNames[cf.id]; if (!k) continue; const v = cf.fieldValueString ?? cf.fieldValue ?? cf.value; f[k] = Array.isArray(v) ? v.join(", ") : v; }
        rows.push({ id: o.id, name: o.name, pipelineId: o.pipelineId, stageId: o.pipelineStageId, status: o.status || "open", value: Number(o.monetaryValue) || 0, createdAt: o.createdAt, lastStageChangeAt: o.lastStageChangeAt, lastStatusChangeAt: o.lastStatusChangeAt, source: o.source || "", contact: o.contact?.name || "", ...f });
      }
      if (list.length < 100) break;
    }
    oppCache = { at: now(), rows }; return rows;
  }

  // --- Media Library (ảnh hiện trường). Cần scope medias.write; thiếu thì ném lỗi 401/403 để nơi gọi tự dự phòng. ---------------
  // Ảnh vào thư mục riêng cho gọn (tạo 1 lần, nhớ id); không tạo/đọc được thư mục thì để ở gốc, không làm hỏng việc upload.
  const FOLDER = "Phiếu dịch vụ"; let folderId;
  async function mediaFolder() {
    if (folderId !== undefined) return folderId;
    folderId = null;
    try {
      const j = await call("GET", `/medias/files?altType=location&altId=${locationId}&type=folder&query=${encodeURIComponent(FOLDER)}&limit=50`, undefined, 1);
      const hit = (j.files || []).find((f) => f.name === FOLDER); if (hit) return (folderId = hit._id || hit.id || null);
      const c = await call("POST", "/medias/folder", { altType: "location", altId: locationId, name: FOLDER }, 1);
      folderId = c._id || c.id || c.folder?._id || null;
    } catch { folderId = null; }
    return folderId;
  }
  async function uploadMedia({ bytes, mime, name }) {
    const fd = new FormData(); fd.append("file", new Blob([bytes], { type: mime }), name); fd.append("name", name); fd.append("hosted", "false");
    const pid = await mediaFolder(); if (pid) fd.append("parentId", pid);
    const r = await fetchImpl(BASE + "/medias/upload-file", { method: "POST", headers: { Authorization: `Bearer ${await getToken()}`, Version: "2021-07-28", Accept: "application/json" }, body: fd });
    const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
    if (!r.ok) { const e = new Error(`GHL POST /medias/upload-file → ${r.status}: ${String(j.message || j.error || text).slice(0, 200)}`); e.status = r.status; throw e; }
    if (!j.fileId || !j.url) throw new Error("GHL không trả về fileId/url của ảnh");
    return { id: j.fileId, url: j.url };
  }

  return {
    locationId,
    listAll, pipelines, opportunities, uploadMedia,
    async deleteMedia(id) { await call("DELETE", `/medias/${encodeURIComponent(id)}?altType=location&altId=${locationId}`, undefined, 1); },
    async getRecord(objectKey, id) { return (await call("GET", `/objects/${objectKey}/records/${id}`)).record; },
    async createRecord(objectKey, properties) {
      const j = await call("POST", `/objects/${objectKey}/records`, { locationId, properties });
      const rec = j.record; if (!rec?.id) throw new Error("GHL không trả về bản ghi vừa tạo");
      const full = { ...rec, properties: { ...(rec.properties || {}), ...properties } };
      note(objectKey, rec.id, full, properties);
      patchCache(objectKey, (rows) => [full, ...rows.filter((r) => r.id !== rec.id)]);
      return rec;
    },
    async updateRecord(objectKey, id, properties) {
      await call("PUT", `/objects/${objectKey}/records/${id}?locationId=${locationId}`, { properties });
      note(objectKey, id, null, properties);
      patchCache(objectKey, (rows) => rows.map((r) => (r.id === id ? { ...r, properties: { ...(r.properties || {}), ...properties } } : r)));
    },
    // Liên kết 2 bản ghi theo KHOÁ association (vd "phieu_thang_may"). GHL có thể đảo thứ tự first/second khi tạo
    // association → tra định nghĩa rồi xếp đúng thứ tự, truyền bản đồ {objectKey: recordId}.
    async relate(assocKey, idsByObject, extra = {}) {
      if (!assocCache) { const j = await call("GET", `/associations/?locationId=${locationId}&skip=0&limit=100`); assocCache = Object.fromEntries((j.associations || []).map((a) => [a.key, a])); }
      const a = assocCache[assocKey]; if (!a) throw new Error(`Không có association ${assocKey}`);
      const f = idsByObject[a.firstObjectKey], s = idsByObject[a.secondObjectKey];
      if (!f || !s) throw new Error(`Thiếu id cho ${assocKey}`);
      return call("POST", "/associations/relations", { locationId, associationId: a.id, firstRecordId: f, secondRecordId: s, ...extra });
    },
    // Tìm contact CÓ SẴN theo SĐT (chỉ đọc — không tạo). Trả id hoặc null. Cần scope contacts.readonly.
    async findContactByPhone(phone) {
      const j = await call("GET", `/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(phone)}`, undefined, 1);
      return j.contact?.id || null;
    },
    // Danh sách nhân viên GHL của sub-account (để giao việc). Có thể thiếu scope users.readonly → trả [] chứ không làm hỏng app.
    async users() {
      try { const j = await call("GET", `/users/?locationId=${locationId}`, undefined, 1); return (j.users || []).map((u) => ({ id: u.id, name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" "), email: u.email })); } catch { return []; }
    },
    invalidate(objectKey) { if (objectKey) cache.delete(objectKey); else cache.clear(); },
  };
}
