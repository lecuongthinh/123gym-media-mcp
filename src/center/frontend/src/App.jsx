import React, { useEffect, useMemo, useState } from "react";

// Đăng nhập qua GHL Custom Menu Link: GHL luôn nhúng app qua iframe trên chính domain của họ (đã xác nhận
// thực tế — kể cả chọn "mở tab mới", thanh địa chỉ vẫn là domain GHL, không phải domain thật của app),
// nên cookie phiên đăng nhập bị trình duyệt chặn vì là cookie bên-thứ-ba. Dùng token qua localStorage +
// header Authorization thay thế — không phụ thuộc chính sách cookie. server.mjs, lúc nhận ?email= hợp lệ,
// trả thẳng index.html có sẵn `window.__CANDY_TOKEN__` — đọc 1 lần lúc app khởi động, lưu vào localStorage,
// dọn sạch khỏi URL để token/email không nằm lại trên thanh địa chỉ.
const TOKEN_KEY = "candy_token";
if (typeof window !== "undefined" && window.__CANDY_TOKEN__) {
  localStorage.setItem(TOKEN_KEY, window.__CANDY_TOKEN__);
  delete window.__CANDY_TOKEN__;
  if (location.search) history.replaceState(null, "", location.pathname + location.hash);
}
// Khi app bị gắn dưới 1 tiền tố đường dẫn (vd /center/* lúc chạy chung service với app khác), gọi API
// bằng đường dẫn tuyệt đối "/api/..." sẽ trật về gốc domain (vd https://host/api/... thay vì
// https://host/center/api/...) vì "/" luôn tính từ gốc domain, không phải từ vị trí trang hiện tại. Vite
// đã biết tiền tố này qua `base` lúc build (xem vite.config.js, biến VITE_BASE_PATH) và expose lại qua
// import.meta.env.BASE_URL — ghép vào đây để MỌI lệnh gọi "/api/..." trong code tự động đúng tiền tố.
const API_BASE_PATH = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const _rawFetch = window.fetch.bind(window);
window.fetch = (input, opts = {}) => {
  let url = typeof input === "string" ? input : input?.url || "";
  const token = localStorage.getItem(TOKEN_KEY);
  if (token && url.startsWith("/api/")) {
    opts = { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } };
  }
  if (typeof input === "string" && url.startsWith("/api/") && API_BASE_PATH) {
    input = API_BASE_PATH + url;
  }
  return _rawFetch(input, opts);
};

const get = (u) => fetch(u).then((r) => r.json());
const maskPhone = (p) => (p ? p.replace(/(\d{4})\s?(\d+)(\d{3})$/, (_, a, b, c) => `${a} ${"•".repeat(b.length)} ${c}`) : "—");
const maskName = (n) => (!n ? "—" : n.includes("@") ? n[0] + "•••@•••" : n.split(" ").map((w, i) => (i === 0 ? w.slice(0, 3) + "•••" : w[0] + "•••")).join(" "));
const fmt = (d) => (d ? new Date(d).toLocaleDateString("vi-VN") : "—");
// Nhiều field ngày trên GHL trả về epoch-ms dạng số thô (vd "Ngày hết hạn hợp đồng": 1828742400000) thay vì
// chuỗi ISO — hiện thẳng String(v) sẽ ra 1 dãy số vô nghĩa. >1e11 chỉ có thể là epoch-ms (epoch giây hiện tại ~1.7e9).
const fmtFieldValue = (v) => (typeof v === "number" && v > 1e11 ? fmt(v) : String(v));

function useDebounced(v, ms) { const [x, setX] = useState(v); useEffect(() => { const t = setTimeout(() => setX(v), ms); return () => clearTimeout(t); }, [v, ms]); return x; }

function List({ mask, open }) {
  const [q, setQ] = useState(""); const [tag, setTag] = useState(""); const [sort, setSort] = useState("recent"); const [page, setPage] = useState(1);
  const [data, setData] = useState(null); const [tags, setTags] = useState([]); const [ms, setMs] = useState(null);
  const dq = useDebounced(q, 250);
  useEffect(() => { get("/api/tags").then(setTags); }, []);
  useEffect(() => { setPage(1); }, [dq, tag, sort]);
  useEffect(() => {
    const t0 = performance.now(); let live = true;
    get(`/api/contacts?q=${encodeURIComponent(dq)}&tag=${encodeURIComponent(tag)}&sort=${sort}&page=${page}`).then((d) => { if (live) { setData(d); setMs(Math.round(performance.now() - t0)); } });
    return () => { live = false; };
  }, [dq, tag, sort, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  return (
    <section>
      <div className="bar">
        <input placeholder="Tìm theo tên hoặc số điện thoại…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={tag} onChange={(e) => setTag(e.target.value)}><option value="">Mọi tag</option>{tags.map(([t, n]) => <option key={t} value={t}>{t} ({n})</option>)}</select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}><option value="recent">Mới cập nhật</option><option value="xu">Nhiều xu nhất</option><option value="name">Tên A–Z</option></select>
        <span className="pill">{data ? `${data.total.toLocaleString("vi-VN")} khách` : "Đang tải…"}</span>
        {ms != null && <span className="pill ok" title="Từ lúc gọi đến lúc có dữ liệu (đã cộng 140 ms độ trễ giả lập)">{ms} ms</span>}
      </div>
      <table>
        <thead><tr><th>Khách</th><th>Điện thoại</th><th>Xu</th><th>Hạng</th><th>Tag</th><th>Tương tác OA</th><th>Zalo</th><th>Ngày tạo</th></tr></thead>
        <tbody>
          {(data?.rows || []).map((c) => (
            <tr key={c.id} onClick={() => open(c.id)}>
              <td className="strong">{mask ? maskName(c.name) : c.name || "—"}</td>
              <td>{mask ? maskPhone(c.phone) : c.phone || "—"}</td>
              <td>{c.fields["Xu tích luỹ"] ?? "—"}</td>
              <td>{c.fields["Hạng VIP Club"] ?? "—"}</td>
              <td className="tags">{c.tags.slice(0, 2).map((t) => <span key={t} className="tag">{t}</span>)}{c.tags.length > 2 && <span className="more">+{c.tags.length - 2}</span>}</td>
              <td>{c.fields["Lần tương tác OA gần nhất"] ? fmt(c.fields["Lần tương tác OA gần nhất"]) : "—"}</td>
              <td>{c.hasZaloUid ? <span className="dot on" title="Có Zalo UID" /> : <span className="dot" />}</td>
              <td>{fmt(c.dateAdded)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Trước</button><span>Trang {page}/{pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau</button></div>
    </section>
  );
}

function Profile({ id, mask, back }) {
  const [c, setC] = useState(null); const [notes, setNotes] = useState(null); const [newTag, setNewTag] = useState(""); const [saved, setSaved] = useState("");
  useEffect(() => { get(`/api/contact/${id}`).then(setC); get(`/api/contact/${id}/notes`).then(setNotes).catch(() => setNotes([])); }, [id]);
  if (!c) return <p className="muted">Đang tải…</p>;
  const addTag = () => {
    const t = newTag.trim(); if (!t) return;
    setC({ ...c, tags: [...c.tags, t] }); setNewTag(""); setSaved("Đã thêm (giao diện đổi ngay)"); // optimistic
    fetch(`/api/contact/${id}/tag`, { method: "POST", body: JSON.stringify({ tag: t }) }).then(() => setSaved("Đã lưu — CHỈ trên máy này, chưa gửi sang GHL (bản demo)"));
  };
  const rows = Object.entries(c.fields);
  return (
    <section className="profile">
      <button className="link" onClick={back}>← Danh sách khách</button>
      <h2>{mask ? maskName(c.name) : c.name || "Chưa có tên"}</h2>
      <p className="muted">{mask ? maskPhone(c.phone) : c.phone || "Chưa có SĐT"} · Tạo ngày {fmt(c.dateAdded)} · {c.hasZaloUid ? "Đã liên kết Zalo" : "Chưa liên kết Zalo"}</p>
      <div className="grid">
        <div className="card"><h3>Thông tin gói & điểm</h3>{rows.length ? <dl>{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{fmtFieldValue(v)}</dd></React.Fragment>)}</dl> : <p className="muted">Chưa có dữ liệu.</p>}</div>
        <div className="card"><h3>Tag</h3><div className="tags">{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
          <div className="row"><input placeholder="Thêm tag…" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag()} /><button onClick={addTag}>Thêm</button></div>
          {saved && <p className="hint">{saved}</p>}</div>
        <div className="card wide"><h3>Ghi chú gần đây <span className="muted">(đọc trực tiếp từ GHL, chỉ đọc)</span></h3>
          {notes === null ? <p className="muted">Đang tải…</p> : notes.length === 0 ? <p className="muted">Không có ghi chú.</p> : notes.map((n, i) => <p key={i} className="note"><b>{fmt(n.at)}</b> — {mask ? "•••• (đang che)" : n.body}</p>)}</div>
      </div>
    </section>
  );
}

const STATUS_ORDER = ["co_mat", "den_muon", "vang_co_phep", "vang_khong_phep"];
const STATUS_SHORT = { co_mat: "Có mặt", den_muon: "Muộn", vang_co_phep: "Vắng (phép)", vang_khong_phep: "Vắng (không phép)" };
// Icon riêng cho từng trạng thái điểm danh — giúp nhận ra nút cần bấm bằng mắt (hình dạng + màu) thay vì
// phải đọc chữ, đỡ hơn khi dùng trên tablet ở sảnh lớp học.
const STATUS_ICON = {
  co_mat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg>,
  den_muon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></svg>,
  vang_co_phep: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11.5 5 15.5V9l4 2.5Z" /><rect x="9" y="7" width="11" height="9" rx="1.6" /></svg>,
  vang_khong_phep: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>,
};
const BUOI_TRANG_THAI = { binh_thuong: "Diễn ra bình thường", huy: "Hủy", hoc_bu: "Buổi học bù" };

// toISOString() quy đổi sang UTC — ở múi giờ dương (VN = UTC+7) sẽ lùi lại 1 ngày lúc 00:00-06:59 giờ địa
// phương. Luôn lấy ngày theo lịch máy người dùng (local), không qua toISOString(), cho mọi giá trị "hôm nay".
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

function Attendance() {
  const [classes, setClasses] = useState(null);
  const [lop, setLop] = useState("");
  const [date, setDate] = useState("2025-08-20"); // ngày có sẵn dữ liệu thật để xem trước
  const [roster, setRoster] = useState(null);
  const [draft, setDraft] = useState({}); // studentN -> {status, note}
  const [saved, setSaved] = useState("");
  const [buoiHoc, setBuoiHoc] = useState(null); // {buoiHoc:{...}|null, writerEnabled}
  const [buoiBusy, setBuoiBusy] = useState(false);

  useEffect(() => { get("/api/candy/classes").then((cs) => { setClasses(cs); if (cs.length) setLop(cs[0].lop); }); }, []);

  const loadBuoiHoc = () => { if (lop && date) get(`/api/candy/buoi-hoc?lop=${encodeURIComponent(lop)}&date=${date}`).then(setBuoiHoc); };

  useEffect(() => {
    if (!lop || !date) return;
    setSaved(""); setRoster(null);
    let stale = false; // đổi lớp/ngày liên tiếp nhanh có thể khiến response cũ về SAU response mới — bỏ qua nếu vậy
    get(`/api/candy/class/${encodeURIComponent(lop)}?date=${date}`).then((d) => {
      if (stale) return;
      setRoster(d);
      const init = {};
      for (const r of d.roster) if (r.marked) init[r.n] = { status: r.marked.status, note: r.marked.note || "" };
      setDraft(init);
    });
    get(`/api/candy/buoi-hoc?lop=${encodeURIComponent(lop)}&date=${date}`).then((d) => { if (!stale) setBuoiHoc(d); });
    return () => { stale = true; };
  }, [lop, date]);

  const setTrangThaiBuoi = (trang_thai) => {
    setBuoiBusy(true);
    fetch("/api/candy/buoi-hoc", { method: "POST", body: JSON.stringify({ lop, date, trang_thai }) })
      .then((r) => r.json())
      // Cập nhật trực tiếp từ kết quả POST thay vì đọc lại qua search — search index của GHL có độ trễ
      // ngắn ngay sau khi ghi nên đọc lại liền có thể vẫn thấy giá trị cũ dù đã ghi đúng.
      .then((saved) => { if (!saved.error) setBuoiHoc((prev) => ({ ...prev, buoiHoc: { ...prev?.buoiHoc, ...saved } })); })
      .finally(() => setBuoiBusy(false));
  };

  const mark = (n, status) => setDraft((d) => ({ ...d, [n]: { status, note: d[n]?.note || "" } }));
  const markAll = (status) => { const next = {}; for (const r of roster.roster) next[r.n] = { status, note: draft[r.n]?.note || "" }; setDraft(next); };
  const noteFor = (n, note) => setDraft((d) => ({ ...d, [n]: { status: d[n]?.status || "co_mat", note } }));

  const submit = () => {
    const marks = {};
    for (const [n, v] of Object.entries(draft)) if (v.status) marks[n] = v;
    setSaved("Đang gửi…");
    fetch("/api/candy/attendance", { method: "POST", body: JSON.stringify({ lop, date, marks }) })
      .then(get2json)
      .then((r) => {
        if (r.writerEnabled) {
          const skipped = r.results.filter((x) => x.status.startsWith("already") || x.status === "skipped_already_real").length;
          const msg = r.errors.length
            ? `Đã ghi ${r.written}/${r.total} vào GHL thật. Lỗi ${r.errors.length}: ${r.errors[0].error}`
            : `Đã ghi THẬT ${r.written} bản ghi Điểm danh mới vào GHL${skipped ? ` (${skipped} em đã có sẵn, không ghi lại)` : ""}.`;
          setSaved(msg);
          get(`/api/candy/class/${encodeURIComponent(lop)}?date=${date}`).then((d) => setRoster(d));
          loadBuoiHoc();
        } else {
          setSaved("Đã lưu — CHỈ trên máy này (chưa bật ghi thật, thiếu token).");
        }
      });
  };
  function get2json(r) { return r.json ? r.json() : r; }

  if (!classes) return <p className="muted">Đang tải…</p>;
  const marked = roster ? Object.keys(draft).length : 0;
  return (
    <section className="attendance">
      <div className="bar">
        <select value={lop} onChange={(e) => setLop(e.target.value)}>
          {classes.map((c) => <option key={c.lop} value={c.lop}>{c.lop} · {CO_SO_LABEL[c.co_so] || c.co_so} · {c.siso} học viên</option>)}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} min="2025-08-01" max="2026-12-31" />
        {roster && <span className="pill">{marked}/{roster.roster.length} đã điểm danh</span>}
      </div>
      {buoiHoc?.writerEnabled && (
        <div className="bar" style={{ marginTop: -4 }}>
          {buoiHoc.buoiHoc ? (
            <>
              <span className="muted">Buổi học:</span>
              <span className={"chip " + (buoiHoc.buoiHoc.trang_thai === "huy" ? "chip-bad" : buoiHoc.buoiHoc.trang_thai === "hoc_bu" ? "chip-warn" : "")}>
                {BUOI_TRANG_THAI[buoiHoc.buoiHoc.trang_thai] || buoiHoc.buoiHoc.trang_thai}
              </span>
              {buoiHoc.buoiHoc.trang_thai !== "binh_thuong" && <button disabled={buoiBusy} onClick={() => setTrangThaiBuoi("binh_thuong")}>Đặt lại bình thường</button>}
              {buoiHoc.buoiHoc.trang_thai !== "huy" && <button disabled={buoiBusy} onClick={() => setTrangThaiBuoi("huy")}>Hủy buổi này</button>}
              {buoiHoc.buoiHoc.trang_thai !== "hoc_bu" && <button disabled={buoiBusy} onClick={() => setTrangThaiBuoi("hoc_bu")}>Đánh dấu là buổi học bù</button>}
            </>
          ) : (
            <span className="muted">Buổi học cho ngày này sẽ được tạo trên GHL khi bạn gửi điểm danh đầu tiên.</span>
          )}
        </div>
      )}
      {roster && (
        <>
          <div className="bulk-row" style={{ background: "var(--acc-soft)", borderRadius: "var(--radius-md)", padding: "10px 14px" }}>
            <span className="strong" style={{ color: "var(--acc)", fontSize: 12.5 }}>Đánh dấu nhanh cả lớp:</span>
            {STATUS_ORDER.map((s) => <button key={s} className="status-btn" onClick={() => markAll(s)}>{STATUS_ICON[s]}{STATUS_SHORT[s]}</button>)}
            <button className="chip clear" onClick={() => setDraft({})} style={{ marginLeft: "auto" }}>Xoá đánh dấu</button>
          </div>
          <table>
            <thead><tr><th>Học viên</th><th>Tổng số buổi</th><th>Trạng thái</th><th>Ghi chú</th></tr></thead>
            <tbody>
              {roster.roster.map((r) => {
                const d = draft[r.n] || {};
                const isReal = r.marked?.real && d.status === r.marked.status && d.note === (r.marked.note || "");
                return (
                  <tr key={r.n} className={isReal ? "real" : ""}>
                    <td className="strong">
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Avatar name={r.name} />
                        {r.name} {isReal && <span className="tag real-tag" title="Đã lưu, không sửa được nữa">Đã lưu</span>}
                      </div>
                    </td>
                    <td>{r.sessions_total ?? "—"}</td>
                    <td className="statuses">
                      {STATUS_ORDER.map((s) => (
                        <button key={s} className={"status-btn " + s + (d.status === s ? " on" : "")} onClick={() => mark(r.n, s)}>{STATUS_ICON[s]}{STATUS_SHORT[s]}</button>
                      ))}
                    </td>
                    <td><input className="note-input" placeholder="Ghi chú…" value={d.note || ""} onChange={(e) => noteFor(r.n, e.target.value)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={submit}>Gửi điểm danh ({marked}/{roster.roster.length})</button>
            {saved && <p className="hint">{saved}</p>}
          </div>
        </>
      )}
    </section>
  );
}

// Nhãn + màu cơ sở KHÔNG còn ghi cứng trong code: sau khi đăng nhập, App nạp danh sách từ GHL của đúng trung
// tâm đang dùng (GET /api/candy/co-so, đọc field `co_so` của object Lớp) và đổ vào 2 object dưới đây — đổi
// tên cơ sở trong CRM là app đổi theo, và khách mới thấy cơ sở của chính họ. Object được sửa tại chỗ (không
// tạo mới) vì rất nhiều component đọc `CO_SO_LABEL[x]` trực tiếp lúc render.
const CO_SO_LABEL = {};
// Màu cũ của 4 cơ sở Candy giữ nguyên để giao diện đang dùng không đổi màu; cơ sở nào không có trong bảng này
// (khách mới) được xoay vòng qua 4 token --co1..--co4 theo thứ tự trong danh sách.
const LEGACY_CO_SO_COLOR = { vin_imperia: "var(--co1)", trung_luc: "var(--co2)", thuy_nguyen: "var(--co3)", quan_nam: "var(--co4)" };
const CO_SO_COLOR = {};
function applyCoSoOptions(options) {
  for (const k of Object.keys(CO_SO_LABEL)) delete CO_SO_LABEL[k];
  for (const k of Object.keys(CO_SO_COLOR)) delete CO_SO_COLOR[k];
  options.forEach((o, i) => { CO_SO_LABEL[o.key] = o.label; CO_SO_COLOR[o.key] = LEGACY_CO_SO_COLOR[o.key] || `var(--co${(i % 4) + 1})`; });
}
const fmtVnd = (n) => n.toLocaleString("vi-VN") + " đ";

const LOP_STATUS = { dang_mo: "Đang mở", da_dong: "Đã đóng", da_ket_thuc: "Đã kết thúc" };
const LOP_STATUS_TONE = { dang_mo: "ok", da_dong: "", da_ket_thuc: "" };
// Pill trạng thái dùng chung (lớp, ghi danh...) — "ok" tô xanh, còn lại tô xám trung tính (không phải mọi
// trạng thái không phải "đang mở" đều xấu — "đã kết thúc" là bình thường, không nên tô đỏ/vàng).
function StatusPill({ label, tone }) {
  return <span className="status-pill" style={tone !== "ok" ? { background: "var(--bg-alt)", color: "var(--mut)" } : undefined}><span className="dot" />{label}</span>;
}
const HV_STATUS = { tiem_nang: "Tiềm năng", dang_hoc: "Đang học", tam_nghi: "Tạm nghỉ", da_nghi: "Đã nghỉ" };

const GD_STATUS = { dang_hoc: "Đang học", tam_nghi: "Tạm nghỉ", da_chuyen_lop: "Đã chuyển lớp", hoan_thanh: "Hoàn thành", da_nghi: "Đã nghỉ" };

const THU_ORDER = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const THU_LABEL = { T2: "Thứ 2", T3: "Thứ 3", T4: "Thứ 4", T5: "Thứ 5", T6: "Thứ 6", T7: "Thứ 7", CN: "Chủ nhật" };
const THU_SHORT = { T2: "T2", T3: "T3", T4: "T4", T5: "T5", T6: "T6", T7: "T7", CN: "CN" };
function formatLichHoc(c) {
  if (!c.cac_thu_hoc) return "";
  const days = c.cac_thu_hoc.split(",").filter(Boolean).map((t) => THU_SHORT[t] || t).join(", ");
  const gio = c.gio_bat_dau && c.gio_ket_thuc ? ` · ${c.gio_bat_dau}-${c.gio_ket_thuc}` : "";
  return days + gio;
}

// Chuẩn ngành (Teachworks/Teach'n Go/Glofox): cảnh báo hết hạn theo ngưỡng, không chỉ hiện ngày trơ.
function expiryInfo(dateStr) {
  if (!dateStr) return { label: "—", cls: "" };
  const days = Math.floor((new Date(dateStr) - new Date()) / 86400000);
  if (days < 0) return { label: `${fmt(dateStr)} (đã hết hạn)`, cls: "chip-bad" };
  if (days <= 30) return { label: `${fmt(dateStr)} (còn ${days} ngày)`, cls: "chip-warn" };
  return { label: fmt(dateStr), cls: "" };
}

// Tìm học viên theo tên, xuyên suốt mọi lớp — trước giờ CHƯA CÓ cách nào làm việc này (phải đoán đúng
// lớp rồi mò trong danh sách). Chỉ 18 học viên thí điểm nên tìm ngay trên máy (client-side), không cần
// route riêng — bỏ dấu tiếng Việt khi so khớp (fold) như cách tab Khách hàng đã làm.
const foldVi = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

// Avatar chữ cái đầu (họ + tên) cho người — thay tên chữ suông trong danh sách bằng 1 khối màu dễ quét mắt
// hơn. Màu chọn theo hash của tên (ổn định, không đổi mỗi lần render) chứ không theo thứ tự hàng, nên cùng
// 1 người luôn ra cùng 1 màu dù đứng ở lớp nào.
const AVATAR_COLORS = ["var(--co1)", "var(--co2)", "var(--co3)", "var(--co4)", "var(--co5)", "var(--co6)"];
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}
function avatarColor(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function Avatar({ name, size }) {
  return <span className={"avatar" + (size ? " " + size : "")} style={{ background: avatarColor(name) }}>{initials(name)}</span>;
}
function TimHocVien() {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(null);
  useEffect(() => { get("/api/candy/hoc-vien-test").then(setAll); }, []);
  const results = q.trim() && all ? all.filter((s) => foldVi(s.name).includes(foldVi(q))).slice(0, 8) : [];
  return (
    <div style={{ position: "relative" }}>
      <input placeholder="Tìm học viên theo tên…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
      {results.length > 0 && (
        <div className="card" style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 5, marginTop: 4, padding: 6 }}>
          {results.map((s) => (
            <div key={s.hoc_vien_id} style={{ padding: "6px 8px", cursor: "pointer", borderRadius: 6 }}
              onMouseDown={() => { setQ(""); location.hash = `#/hoc-vien/${encodeURIComponent(s.hoc_vien_id)}`; }}>
              <span className="strong">{s.name}</span> <span className="muted">· {s.lops.map((l) => l.lop).join(", ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Tạo lớp mới — trước đây app chỉ xem/sửa lớp có sẵn trên GHL; khách mới (đặc biệt cài qua OAuth, chưa có
// lớp nào) cần cách bắt đầu từ con số 0 ngay trong app, không phải tự vào GHL tạo record tay.
function CreateLopForm({ onDone, onCancel }) {
  const [name, setName] = useState("");
  const [coSo, setCoSo] = useState("");
  const [capDo, setCapDo] = useState("");
  const [siSoToiDa, setSiSoToiDa] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const coSoOptions = Object.entries(CO_SO_LABEL);
  const submit = () => {
    if (!name.trim()) { setErr("Nhập tên lớp."); return; }
    setBusy(true); setErr("");
    fetch("/api/candy/lop-tao", { method: "POST", body: JSON.stringify({ name, coSo, capDo, siSoToiDa: Number(siSoToiDa) || undefined }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } onDone(); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="card wide">
      <h3>Tạo lớp mới</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Tên lớp
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: A1 - Sáng T2T4T6" style={{ width: 220 }} />
        </label>
        {coSoOptions.length > 0 && (
          <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Cơ sở
            <select value={coSo} onChange={(e) => setCoSo(e.target.value)}>
              <option value="">— Chọn cơ sở —</option>
              {coSoOptions.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
        )}
        <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Cấp độ (tuỳ chọn)
          <input type="text" value={capDo} onChange={(e) => setCapDo(e.target.value)} style={{ width: 140 }} />
        </label>
        <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Sĩ số tối đa (tuỳ chọn)
          <input type="number" min="0" value={siSoToiDa} onChange={(e) => setSiSoToiDa(e.target.value)} style={{ width: 100 }} />
        </label>
      </div>
      <div className="row">
        <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang tạo…" : "Tạo lớp"}</button>
        <button onClick={onCancel} disabled={busy}>Huỷ</button>
      </div>
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
    </div>
  );
}

function ClassList({ openLop }) {
  const [classes, setClasses] = useState(null);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const reload = () => get("/api/candy/classes").then(setClasses);
  useEffect(() => { reload(); }, []);
  if (!classes) return <p className="muted">Đang tải…</p>;
  const shown = hideEmpty ? classes.filter((c) => c.siso > 0) : classes;
  return (
    <section>
      <div className="bar">
        <TimHocVien />
        <span className="pill">{shown.length}/{classes.length} lớp</span>
        <label className="mask" style={{ marginLeft: 0 }}><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Chỉ hiện lớp có học viên</label>
        <button className="link" style={{ marginLeft: "auto" }} onClick={() => setShowCreate((v) => !v)}>{showCreate ? "Đóng" : "+ Tạo lớp mới"}</button>
      </div>
      {showCreate && <CreateLopForm onDone={() => { setShowCreate(false); reload(); }} onCancel={() => setShowCreate(false)} />}
      <table>
        <thead><tr><th>Lớp</th><th>Cấp độ</th><th>Cơ sở</th><th>Sĩ số hiện tại</th><th>Trạng thái</th><th>Giáo viên</th><th>Lịch học</th><th>Sĩ số tối đa</th></tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.lop} onClick={() => openLop(c.lop)}>
              <td className="strong">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="avatar" style={{ borderRadius: 9, background: avatarColor(c.lop) }}>{c.lop.slice(0, 2).toUpperCase()}</span>
                  {c.lop}
                </div>
              </td>
              <td className={c.cap_do ? "" : "muted"}>{c.cap_do || "—"}</td>
              <td>{CO_SO_LABEL[c.co_so] || c.co_so}</td>
              <td>{c.siso}</td>
              <td><StatusPill label={LOP_STATUS[c.trang_thai] || c.trang_thai} tone={LOP_STATUS_TONE[c.trang_thai]} /></td>
              <td>{c.giao_vien ? c.giao_vien : <span className="empty-chip">Chưa gán</span>}</td>
              <td>{formatLichHoc(c) || <span className="empty-chip">Chưa nhập lịch</span>}</td>
              <td className={c.si_so_toi_da ? "" : "muted"}>{c.si_so_toi_da || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Bảng điểm danh/lớp chỉ giữ thông tin "cần liếc là biết phải làm gì" (chuẩn Glofox/Teachworks:
// trạng thái + hạn dùng dạng chip màu, không dồn hết mọi trường vào 1 bảng). Chi tiết đầy đủ nằm
// ở trang riêng từng học viên (bấm vào dòng), giống hệt cách "Khách hàng" đã làm (danh sách → hồ sơ).
// Xếp lớp: form ghi danh 1 học viên (trong 18 hs thí điểm) vào lớp đang xem. Ghi THẬT vào GHL khi bấm
// gửi — không có bước "nháp cục bộ" như điểm danh, vì ghi danh là hành động rời rạc (không cần sửa nhiều
// lần trước khi chốt như đánh dấu điểm danh cả lớp) nên không cần optimistic/local-first ở đây.
function EnrollForm({ lop, siSoHienTai, siSoToiDa, onDone, onCancel }) {
  const [options, setOptions] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [hocVienId, setHocVienId] = useState("");
  const [newName, setNewName] = useState("");
  const [newNgaySinh, setNewNgaySinh] = useState("");
  const [ngayBatDau, setNgayBatDau] = useState(todayISO);
  const [ngayHetHan, setNgayHetHan] = useState("");
  const [tongSoBuoi, setTongSoBuoi] = useState("");
  const [hocPhi, setHocPhi] = useState("");
  const [tienGiaoCu, setTienGiaoCu] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { get("/api/candy/hoc-vien-test").then(setOptions); }, []);
  const full = siSoToiDa && siSoHienTai >= siSoToiDa;
  const submit = () => {
    if (isNew) { if (!newName.trim()) { setErr("Nhập tên học viên mới."); return; } }
    else if (!hocVienId) { setErr("Chọn 1 học viên."); return; }
    setBusy(true); setErr("");
    const payload = {
      lop, ngayBatDau, ngayHetHan, tongSoBuoi: Number(tongSoBuoi) || 0, hocPhi: Number(hocPhi) || 0, tienGiaoCu: Number(tienGiaoCu) || 0,
      ...(isNew ? { newStudent: { name: newName.trim(), ngaySinh: newNgaySinh } } : { hocVienId }),
    };
    fetch("/api/candy/ghi-danh", { method: "POST", body: JSON.stringify(payload) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } onDone(); })
      .finally(() => setBusy(false));
  };
  if (full) return <div className="card wide"><p className="muted">Lớp đã đủ sĩ số tối đa ({siSoToiDa}), không thể xếp thêm học viên. <button className="link" style={{ display: "inline" }} onClick={onCancel}>Đóng</button></p></div>;
  return (
    <div className="card wide">
      <h3>Ghi danh học viên vào {lop}</h3>
      {!options ? <p className="muted">Đang tải danh sách học viên…</p> : (
        <>
          <div className="row" style={{ gap: 16, marginBottom: 4 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="radio" checked={!isNew} onChange={() => setIsNew(false)} /> Học viên có sẵn
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="radio" checked={isNew} onChange={() => setIsNew(true)} /> Học viên mới
            </label>
          </div>
          {!isNew ? (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <select value={hocVienId} onChange={(e) => setHocVienId(e.target.value)}>
                <option value="">— Chọn học viên —</option>
                {options.map((o) => <option key={o.hoc_vien_id} value={o.hoc_vien_id}>{o.name} ({o.lops.map((l) => l.lop).join(", ")})</option>)}
              </select>
            </div>
          ) : (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Họ tên học viên mới
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="VD: Nguyễn Văn A" style={{ width: 220 }} />
              </label>
              <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Ngày sinh
                <input type="date" value={newNgaySinh} onChange={(e) => setNewNgaySinh(e.target.value)} />
              </label>
            </div>
          )}
          <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Ngày bắt đầu
              <input type="date" value={ngayBatDau} onChange={(e) => setNgayBatDau(e.target.value)} />
            </label>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Ngày hết hạn
              <input type="date" value={ngayHetHan} onChange={(e) => setNgayHetHan(e.target.value)} />
            </label>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Tổng số buổi
              <input type="number" min="0" value={tongSoBuoi} onChange={(e) => setTongSoBuoi(e.target.value)} style={{ width: 100 }} />
            </label>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Học phí (đ)
              <input type="number" min="0" value={hocPhi} onChange={(e) => setHocPhi(e.target.value)} style={{ width: 130 }} />
            </label>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Tiền giáo cụ (đ)
              <input type="number" min="0" value={tienGiaoCu} onChange={(e) => setTienGiaoCu(e.target.value)} style={{ width: 130 }} />
            </label>
          </div>
          <div className="row">
            <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang lưu…" : "Ghi danh"}</button>
            <button onClick={onCancel} disabled={busy}>Huỷ</button>
          </div>
          {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
        </>
      )}
    </div>
  );
}

// Thời khoá biểu (Đợt "quản lý lớp còn thiếu gì" #2): chọn thứ (checkbox nhiều lựa chọn) + khung giờ —
// đúng chuẩn Teachworks/Glofox, không gõ tay 1 ô chữ tự do như "lịch học" cũ. Server tự kiểm tra trùng
// lịch dạy của giáo viên trước khi ghi, nên form chỉ cần hiện lỗi nếu server trả về.
function LichHocForm({ lop, currentThu, currentBatDau, currentKetThuc, onDone, onCancel }) {
  const [thu, setThu] = useState(() => new Set((currentThu || "").split(",").filter(Boolean)));
  const [gioBatDau, setGioBatDau] = useState(currentBatDau || "");
  const [gioKetThuc, setGioKetThuc] = useState(currentKetThuc || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toggle = (t) => setThu((s) => { const next = new Set(s); next.has(t) ? next.delete(t) : next.add(t); return next; });
  const submit = () => {
    setBusy(true); setErr("");
    fetch("/api/candy/lich-hoc", { method: "POST", body: JSON.stringify({ lop, cacThuHoc: [...thu], gioBatDau, gioKetThuc }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } onDone(); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="card wide">
      <h3>Sửa lịch học — {lop}</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {THU_ORDER.map((t) => (
          <label key={t} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={thu.has(t)} onChange={() => toggle(t)} /> {THU_LABEL[t]}
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Giờ bắt đầu
          <input type="time" value={gioBatDau} onChange={(e) => setGioBatDau(e.target.value)} />
        </label>
        <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Giờ kết thúc
          <input type="time" value={gioKetThuc} onChange={(e) => setGioKetThuc(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang lưu…" : "Lưu"}</button>
        <button onClick={onCancel} disabled={busy}>Huỷ</button>
      </div>
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
    </div>
  );
}

// Sinh lịch buổi học trước: tạo Buổi học cho N tuần sắp tới dựa trên lịch học đã nhập, thay vì chỉ tạo
// phản ứng lúc điểm danh — để staff thấy/huỷ/xếp GV dạy thay TRƯỚC ngày học diễn ra.
function GenerateSessionsForm({ lop, onClose }) {
  const [soTuan, setSoTuan] = useState(4);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const submit = () => {
    setBusy(true); setErr(""); setResult(null);
    fetch("/api/candy/sinh-lich-buoi-hoc", { method: "POST", body: JSON.stringify({ lop, soTuan: Number(soTuan) || 4 }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } setResult(j); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="card wide">
      <h3>Sinh lịch buổi học trước — {lop}</h3>
      <p className="muted">Tạo trước Buổi học cho các ngày khớp lịch học trong N tuần tới — để chủ động huỷ/xếp GV dạy thay trước ngày học diễn ra, thay vì chỉ biết sau khi điểm danh.</p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Số tuần tới
          <input type="number" min="1" max="8" value={soTuan} onChange={(e) => setSoTuan(e.target.value)} style={{ width: 80 }} />
        </label>
      </div>
      <div className="row">
        <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang tạo…" : "Sinh lịch"}</button>
        <button onClick={onClose} disabled={busy}>Đóng</button>
      </div>
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
      {result && (
        <div style={{ marginTop: 8 }}>
          <p className="hint">Xong: {result.total} buổi trong khoảng đã chọn — {result.created} buổi mới tạo, {result.existing} buổi đã có sẵn từ trước.</p>
          <ul className="attention-list">
            {result.dates.map((r) => (
              <li key={r.date}>{fmt(r.date)} {r.created ? <span className="chip real-tag" style={{ marginLeft: 8 }}>MỚI TẠO</span> : <span className="muted" style={{ marginLeft: 8 }}>(đã có)</span>}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// 1 dòng Buổi học: đổi trạng thái tức thì (chuẩn giống nút ở Điểm danh), gán GV dạy thay lưu khi rời ô
// (không lưu theo từng phím gõ) — field này có trên schema từ đầu nhưng chưa từng có UI, y hệt lỗi "field
// chết" đã gặp ở trạng thái Ghi danh trước đây.
function BuoiHocRow({ item, lop, busy, onBusy, onSaved, onError }) {
  const [gv, setGv] = useState(item.giao_vien_day || "");
  useEffect(() => { setGv(item.giao_vien_day || ""); }, [item.giao_vien_day]);
  const save = (patch) => {
    onBusy(true); onError("");
    fetch("/api/candy/buoi-hoc-update", { method: "POST", body: JSON.stringify({ buoiHocId: item.id, lop, ...patch }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { onError(j.error || "Lỗi không rõ"); return; } onSaved(patch); })
      .finally(() => onBusy(false));
  };
  return (
    <tr>
      <td className="strong">{fmt(item.ngay)}</td>
      <td>
        {["binh_thuong", "huy", "hoc_bu"].map((t) => (
          <button key={t} disabled={busy || t === item.trang_thai} style={t === item.trang_thai ? { opacity: .5 } : {}} onClick={() => save({ trangThai: t })}>{BUOI_TRANG_THAI[t]}</button>
        ))}
      </td>
      <td>
        <input className="note-input" placeholder="Tên GV dạy thay…" value={gv} disabled={busy}
          onChange={(e) => setGv(e.target.value)}
          onBlur={() => { if (gv !== (item.giao_vien_day || "")) save({ giaoVienDay: gv }); }} />
      </td>
    </tr>
  );
}

function BuoiHocList({ lop, onClose }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { get(`/api/candy/buoi-hoc-list?lop=${encodeURIComponent(lop)}`).then((d) => setItems(d.items || [])); }, [lop]);
  const applyPatch = (id, patch) => setItems((arr) => arr.map((x) => x.id === id ? { ...x, trang_thai: patch.trangThai ?? x.trang_thai, giao_vien_day: patch.giaoVienDay ?? x.giao_vien_day } : x));
  return (
    <div className="card wide">
      <h3>Danh sách buổi học — {lop}</h3>
      {!items ? <p className="muted">Đang tải…</p> : items.length === 0 ? (
        <p className="muted">Chưa có Buổi học nào. Dùng "Sinh lịch buổi học trước" ở trên, hoặc điểm danh 1 lần để tự tạo.</p>
      ) : (
        <table>
          <thead><tr><th>Ngày</th><th>Trạng thái</th><th>GV dạy thay</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <BuoiHocRow key={it.id} item={it} lop={lop} busy={busy} onBusy={setBusy} onError={setErr}
                onSaved={(patch) => applyPatch(it.id, patch)} />
            ))}
          </tbody>
        </table>
      )}
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
      <div className="row"><button onClick={onClose}>Đóng</button></div>
    </div>
  );
}

function ClassDetail({ lop, back, openStudent }) {
  const [d, setD] = useState(null);
  const [enrolling, setEnrolling] = useState(false);
  const [editingLich, setEditingLich] = useState(false);
  const [generatingSessions, setGeneratingSessions] = useState(false);
  const [showingSessions, setShowingSessions] = useState(false);
  const [assigningTeacher, setAssigningTeacher] = useState(false);
  const [saved, setSaved] = useState("");
  const load = () => get(`/api/candy/lop?lop=${encodeURIComponent(lop)}`).then(setD);
  useEffect(() => { setD(null); setEnrolling(false); setEditingLich(false); setGeneratingSessions(false); setShowingSessions(false); setAssigningTeacher(false); load(); }, [lop]);
  if (!d) return <p className="muted">Đang tải…</p>;
  return (
    <section>
      <button className="link" onClick={back}>← Danh sách lớp</button>
      <h2>{d.lop}</h2>
      <p className="muted">
        {d.cap_do ? `Cấp độ: ${d.cap_do} · ` : ""}{CO_SO_LABEL[d.co_so] || d.co_so} · {LOP_STATUS[d.trang_thai] || d.trang_thai} · {d.roster.length} học viên{d.si_so_toi_da ? `/${d.si_so_toi_da}` : ""}
        {d.giao_vien ? ` · GV: ${d.giao_vien}` : ""}{formatLichHoc(d) ? ` · ${formatLichHoc(d)}` : ""}
        {" · "}<button className="link" style={{ display: "inline" }} onClick={() => setAssigningTeacher((v) => !v)}>{d.giao_vien ? "Đổi giáo viên" : "+ Gán giáo viên"}</button>
        {" · "}<button className="link" style={{ display: "inline" }} onClick={() => setEditingLich((v) => !v)}>{formatLichHoc(d) ? "Sửa lịch học" : "+ Thêm lịch học"}</button>
        {formatLichHoc(d) && <>{" · "}<button className="link" style={{ display: "inline" }} onClick={() => setGeneratingSessions((v) => !v)}>Sinh lịch buổi học trước</button></>}
        {" · "}<button className="link" style={{ display: "inline" }} onClick={() => setShowingSessions((v) => !v)}>Danh sách buổi học</button>
      </p>
      {assigningTeacher && (
        <AssignTeacherForm lop={lop}
          onDone={() => { setAssigningTeacher(false); setSaved("Đã gán giáo viên thật vào GHL."); load(); }}
          onCancel={() => setAssigningTeacher(false)} />
      )}
      {editingLich && (
        <LichHocForm lop={lop} currentThu={d.cac_thu_hoc} currentBatDau={d.gio_bat_dau} currentKetThuc={d.gio_ket_thuc}
          onDone={() => { setEditingLich(false); setSaved("Đã lưu lịch học thật vào GHL."); load(); }}
          onCancel={() => setEditingLich(false)} />
      )}
      {generatingSessions && <GenerateSessionsForm lop={lop} onClose={() => setGeneratingSessions(false)} />}
      {showingSessions && <BuoiHocList lop={lop} onClose={() => setShowingSessions(false)} />}
      {d.roster.length === 0 ? <p className="muted">Lớp này chưa có học viên nào (đúng như trên GHL).</p> : (
      <table>
        <thead><tr><th>Học viên</th><th>Trạng thái ghi danh</th><th>Đã học / Tổng buổi</th><th>Ngày hết hạn</th></tr></thead>
        <tbody>{d.roster.map((s) => {
          const exp = expiryInfo(s.ngay_het_han);
          return (
            <tr key={s.n} onClick={() => openStudent(s)} style={{ cursor: "pointer" }}>
              <td className="strong">{s.name}</td>
              <td>{GD_STATUS[s.gd_trang_thai] || s.gd_trang_thai}</td>
              <td>{s.so_buoi_da_hoc ?? 0} / {s.sessions_total ?? "—"}</td>
              <td><span className={"chip " + exp.cls}>{exp.label}</span></td>
            </tr>
          );
        })}</tbody>
      </table>
      )}
      {enrolling ? (
        <div style={{ marginTop: 12 }}>
          <EnrollForm lop={lop} siSoHienTai={d.roster.length} siSoToiDa={Number(d.si_so_toi_da) || 0}
            onDone={() => { setEnrolling(false); setSaved("Đã ghi danh thật vào GHL."); load(); }}
            onCancel={() => setEnrolling(false)} />
        </div>
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => { setEnrolling(true); setSaved(""); }}>+ Ghi danh học viên vào lớp này</button>
          {saved && <span className="hint">{saved}</span>}
        </div>
      )}
      <p className="muted" style={{ marginTop: 10 }}>Muốn điểm danh lớp này? Qua tab "Điểm danh" và chọn đúng tên lớp. Bấm vào 1 học viên để xem đầy đủ thông tin ghi danh.</p>
    </section>
  );
}

// Hồ sơ ghi danh của 1 học viên trong 1 lớp — mọi chi tiết dồn ở đây thay vì nhồi vào bảng danh sách.
// Đồng bộ CRM: 1 Học viên luôn thuộc về 1 Contact (phụ huynh) trên GHL — hiện tên/SĐT/email thật,
// đọc qua association có sẵn (contact_hoc_vien), không phải dữ liệu nhập tay riêng cho app này.
function PhuHuynhCard({ hocVienId, wide }) {
  const [d, setD] = useState(null);
  useEffect(() => { setD(null); if (hocVienId) get(`/api/candy/phu-huynh/${encodeURIComponent(hocVienId)}`).then(setD); }, [hocVienId]);
  if (!d || !d.writerEnabled) return null;
  const cls = "card" + (wide ? " wide" : "");
  if (!d.phuHuynh) return (
    <div className={cls}>
      <h3>Phụ huynh</h3>
      <p className="muted">Không tìm thấy liên kết Contact (phụ huynh) cho học viên này trên GHL.</p>
    </div>
  );
  const p = d.phuHuynh;
  return (
    <div className={cls}>
      <h3>Phụ huynh <span className="muted" style={{ fontWeight: 400 }}>· đồng bộ từ CRM</span></h3>
      <dl>
        <dt>Họ tên</dt><dd>{p.name || "—"}</dd>
        <dt>Điện thoại</dt><dd>{p.phone || "—"}</dd>
        <dt>Email</dt><dd>{p.email || "—"}</dd>
      </dl>
    </div>
  );
}

// Gia hạn (Đợt "quản lý lớp còn thiếu gì" #7): PATCH thật vào GHL, gắn trực tiếp dưới card Ghi danh vì
// đây là hành động của đúng 1 Ghi danh, không cần trang riêng. onDone nhận lại patch để nơi gọi tự cập
// nhật hiển thị (không bắt buộc phải fetch lại từ server).
function RenewForm({ ghiDanhId, currentHetHan, currentTongSoBuoi, onDone }) {
  const [open, setOpen] = useState(false);
  const [ngayHetHanMoi, setNgayHetHanMoi] = useState(currentHetHan || "");
  const [tongSoBuoiMoi, setTongSoBuoiMoi] = useState(currentTongSoBuoi || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!open) return <button style={{ marginTop: 10 }} onClick={() => setOpen(true)}>Gia hạn</button>;
  const submit = () => {
    setBusy(true); setErr("");
    fetch("/api/candy/gia-han", { method: "POST", body: JSON.stringify({ ghiDanhId, ngayHetHanMoi, tongSoBuoiMoi: Number(tongSoBuoiMoi) || 0 }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } setOpen(false); onDone({ ngay_het_han: j.ngay_het_han, sessions_total: j.sessions_total }); })
      .finally(() => setBusy(false));
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Ngày hết hạn mới
          <input type="date" value={ngayHetHanMoi} onChange={(e) => setNgayHetHanMoi(e.target.value)} />
        </label>
        <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Tổng số buổi mới
          <input type="number" min="0" value={tongSoBuoiMoi} onChange={(e) => setTongSoBuoiMoi(e.target.value)} style={{ width: 100 }} />
        </label>
      </div>
      <div className="row">
        <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang lưu…" : "Xác nhận gia hạn"}</button>
        <button onClick={() => setOpen(false)} disabled={busy}>Huỷ</button>
      </div>
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
    </div>
  );
}

// Chuyển lớp: tạo Ghi danh MỚI ở lớp khác + tự đóng Ghi danh CŨ (trạng thái "Đã chuyển lớp") — 1 thao tác,
// không phải 2 bước rời rạc dễ quên. Form giống EnrollForm (chọn ngày/số buổi/học phí cho gói mới), khác
// ở chỗ chọn LỚP thay vì chọn học viên (học viên đã biết — đang đứng trên trang của chính họ).
function TransferForm({ ghiDanhIdCu, hocVienId, studentName, lopCu, onDone, onCancel }) {
  const [classes, setClasses] = useState(null);
  const [lopMoi, setLopMoi] = useState("");
  const [ngayBatDau, setNgayBatDau] = useState(todayISO);
  const [ngayHetHan, setNgayHetHan] = useState("");
  const [tongSoBuoi, setTongSoBuoi] = useState("");
  const [hocPhi, setHocPhi] = useState("");
  const [tienGiaoCu, setTienGiaoCu] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [warn, setWarn] = useState("");
  useEffect(() => { get("/api/candy/classes").then(setClasses); }, []);
  const submit = () => {
    if (!lopMoi) { setErr("Chọn lớp mới."); return; }
    setBusy(true); setErr(""); setWarn("");
    fetch("/api/candy/chuyen-lop", { method: "POST", body: JSON.stringify({ ghiDanhIdCu, hocVienId, lopMoi, ngayBatDau, ngayHetHan, tongSoBuoi: Number(tongSoBuoi) || 0, hocPhi: Number(hocPhi) || 0, tienGiaoCu: Number(tienGiaoCu) || 0 }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } if (j.warning) { setWarn(j.warning); return; } onDone(); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="card wide">
      <h3>Chuyển lớp — {studentName}</h3>
      <p className="muted">Từ {lopCu} sang lớp khác: tạo 1 Ghi danh mới, đóng Ghi danh cũ (Đã chuyển lớp) — không xoá lịch sử.</p>
      {!classes ? <p className="muted">Đang tải danh sách lớp…</p> : (
        <>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <select value={lopMoi} onChange={(e) => setLopMoi(e.target.value)}>
              <option value="">— Chọn lớp mới —</option>
              {classes.filter((c) => c.lop !== lopCu).map((c) => <option key={c.lop} value={c.lop}>{c.lop} · {CO_SO_LABEL[c.co_so] || c.co_so} · {c.siso}{c.si_so_toi_da ? `/${c.si_so_toi_da}` : ""} hv</option>)}
            </select>
          </div>
          <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Ngày bắt đầu
              <input type="date" value={ngayBatDau} onChange={(e) => setNgayBatDau(e.target.value)} />
            </label>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Ngày hết hạn
              <input type="date" value={ngayHetHan} onChange={(e) => setNgayHetHan(e.target.value)} />
            </label>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Tổng số buổi
              <input type="number" min="0" value={tongSoBuoi} onChange={(e) => setTongSoBuoi(e.target.value)} style={{ width: 100 }} />
            </label>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Học phí (đ)
              <input type="number" min="0" value={hocPhi} onChange={(e) => setHocPhi(e.target.value)} style={{ width: 130 }} />
            </label>
            <label className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>Tiền giáo cụ (đ)
              <input type="number" min="0" value={tienGiaoCu} onChange={(e) => setTienGiaoCu(e.target.value)} style={{ width: 130 }} />
            </label>
          </div>
          <div className="row">
            <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang lưu…" : "Xác nhận chuyển lớp"}</button>
            <button onClick={onCancel} disabled={busy}>Huỷ</button>
          </div>
          {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
          {warn && <p style={{ color: "var(--warn)" }}>{warn} <button className="link" style={{ display: "inline" }} onClick={onDone}>Đã hiểu, đóng</button></p>}
        </>
      )}
    </div>
  );
}

// Đặt lịch học bù thực tế (Đợt "quản lý lớp còn thiếu gì" #8): nối luật đã cấu hình ở tab Cấu hình thành
// 1 thao tác ghi thật. Chọn lớp bù CÙNG CẤP ĐỘ (quy tắc cố định) từ danh sách server đã lọc sẵn, không tự
// gõ tên lớp — tránh chọn nhầm lớp khác cấp độ mà server mới báo lỗi.
function BookMakeUpForm({ ghiDanhId, ngayVang, loaiVang, lopGoc, onDone, onCancel }) {
  const [list, setList] = useState(null);
  const [lopBu, setLopBu] = useState("");
  const [ngayBu, setNgayBu] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { get(`/api/candy/lop-cung-cap-do?lop=${encodeURIComponent(lopGoc)}`).then(setList); }, [lopGoc]);
  const submit = () => {
    if (!lopBu || !ngayBu) { setErr("Chọn lớp bù và ngày bù."); return; }
    setBusy(true); setErr("");
    fetch("/api/candy/dat-hoc-bu", { method: "POST", body: JSON.stringify({ ghiDanhId, ngayVang, loaiVang, lopGoc, lopBu, ngayBu }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } onDone(); })
      .finally(() => setBusy(false));
  };
  return (
    <div style={{ marginTop: 6, marginBottom: 6, padding: 8, border: "1px dashed var(--line)", borderRadius: 8 }}>
      {!list ? <p className="muted">Đang tải danh sách lớp cùng cấp độ…</p> : !list.capDo ? (
        <p className="muted">Lớp gốc chưa có cấp độ trên GHL — không xác định được lớp cùng cấp độ để làm lớp bù. <button className="link" style={{ display: "inline" }} onClick={onCancel}>Đóng</button></p>
      ) : list.list.length === 0 ? (
        <p className="muted">Chưa có lớp nào cùng cấp độ "{list.capDo}" đã nhập lịch học để chọn làm lớp bù. <button className="link" style={{ display: "inline" }} onClick={onCancel}>Đóng</button></p>
      ) : (
        <>
          <div className="row" style={{ marginTop: 0, flexWrap: "wrap" }}>
            <select value={lopBu} onChange={(e) => setLopBu(e.target.value)}>
              <option value="">— Chọn lớp bù (cùng cấp độ {list.capDo}) —</option>
              {list.list.map((c) => <option key={c.lop} value={c.lop}>{c.lop} · {formatLichHoc(c)}</option>)}
            </select>
            <input type="date" value={ngayBu} onChange={(e) => setNgayBu(e.target.value)} />
          </div>
          <div className="row">
            <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang lưu…" : "Xác nhận đặt học bù"}</button>
            <button onClick={onCancel} disabled={busy}>Huỷ</button>
          </div>
          {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
        </>
      )}
    </div>
  );
}

// Danh sách lịch sử điểm danh + thao tác "Đặt học bù" ngay tại buổi vắng đủ điều kiện — quota (đã dùng/tối
// đa) đọc từ tab Cấu hình, buổi đã đặt bù rồi thì hiện luôn kết quả thay vì cho đặt lại.
function AttendanceHistory({ ghiDanhId, lop, attendance }) {
  const [hocBu, setHocBu] = useState(null);
  const [bookingFor, setBookingFor] = useState(null);
  const loadHocBu = () => get(`/api/candy/hoc-bu?ghiDanhId=${encodeURIComponent(ghiDanhId)}`).then(setHocBu);
  useEffect(() => { loadHocBu(); }, [ghiDanhId]);
  if (attendance.length === 0) return <p className="muted">Chưa có lượt điểm danh nào.</p>;
  return (
    <>
      {hocBu && <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>Học bù: đã dùng {hocBu.used}/{hocBu.max} buổi cho phép mỗi kỳ ghi danh.</p>}
      <ul className="attention-list">
        {attendance.map((a, i) => {
          const isVang = a.status.startsWith("vang");
          const booking = hocBu?.bookings.find((b) => b.ngayVang === a.date);
          const eligible = isVang && hocBu && !booking && hocBu.used < hocBu.max && (!hocBu.loaiVangDuocBu.length || hocBu.loaiVangDuocBu.includes(a.status));
          return (
            <li key={i}>
              {fmt(a.date)} — {STATUS_SHORT[a.status] || a.status}
              {!a.real && <span className="chip chip-bad" style={{ marginLeft: 8 }} title="Chưa lưu được vào hệ thống">Chưa đồng bộ</span>}
              {booking && <span className="chip chip-warn" style={{ marginLeft: 8 }}>Đã đặt bù: {booking.lopBu} · {fmt(booking.ngayBu)}</span>}
              {eligible && bookingFor !== a.date && <button style={{ marginLeft: 8 }} onClick={() => setBookingFor(a.date)}>Đặt học bù</button>}
              {bookingFor === a.date && (
                <BookMakeUpForm ghiDanhId={ghiDanhId} ngayVang={a.date} loaiVang={a.status} lopGoc={lop}
                  onDone={() => { setBookingFor(null); loadHocBu(); }}
                  onCancel={() => setBookingFor(null)} />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// Đóng vòng đời ghi danh: 5 trạng thái đã có sẵn trong data từ đầu nhưng chỉ "Đang học" từng có đường ghi
// (qua Xếp lớp) — Tạm nghỉ/Hoàn thành/Đã nghỉ là field chết cho tới giờ. "Đã chuyển lớp" cố tình không có
// nút riêng ở đây, chỉ đi qua TransferForm vì cần tạo Ghi danh mới kèm theo, không phải chỉ đổi 1 chữ.
function EnrollmentStatusActions({ ghiDanhId, hocVienId, studentName, lop, gdTrangThai, onDone }) {
  const [showTransfer, setShowTransfer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const setStatus = (trangThai) => {
    if (trangThai === gdTrangThai) return;
    setBusy(true); setErr("");
    fetch("/api/candy/ghi-danh-trang-thai", { method: "POST", body: JSON.stringify({ ghiDanhId, trangThai }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } onDone({ gd_trang_thai: trangThai }); })
      .finally(() => setBusy(false));
  };
  if (showTransfer) return <TransferForm ghiDanhIdCu={ghiDanhId} hocVienId={hocVienId} studentName={studentName} lopCu={lop} onDone={() => { setShowTransfer(false); onDone({ gd_trang_thai: "da_chuyen_lop" }); }} onCancel={() => setShowTransfer(false)} />;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ marginTop: 0, flexWrap: "wrap" }}>
        {Object.entries(GD_STATUS).filter(([k]) => k !== "da_chuyen_lop").map(([k, label]) => (
          <button key={k} onClick={() => setStatus(k)} disabled={busy || k === gdTrangThai} style={k === gdTrangThai ? { opacity: .5 } : {}}>{label}</button>
        ))}
        <button onClick={() => setShowTransfer(true)} disabled={busy}>Chuyển lớp…</button>
      </div>
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
    </div>
  );
}

function StudentInClassDetail({ student, lop, back }) {
  const [override, setOverride] = useState({});
  const s = { ...student, ...override };
  const expStart = s.ngay_bat_dau ? fmt(s.ngay_bat_dau) : "—";
  const exp = expiryInfo(s.ngay_het_han);
  return (
    <section>
      <button className="link" onClick={back}>← {lop}</button>
      <h2>{s.name}</h2>
      <p className="muted">{s.ngay_sinh ? `Sinh ${fmt(s.ngay_sinh)} · ` : ""}{CO_SO_LABEL[s.co_so] || s.co_so} · Trạng thái học viên: {HV_STATUS[s.hv_trang_thai] || s.hv_trang_thai}</p>
      <div className="grid" style={{ marginTop: 12 }}>
        <div className="card">
          <h3>Ghi danh — {lop}</h3>
          <dl>
            <dt>Trạng thái ghi danh</dt><dd>{GD_STATUS[s.gd_trang_thai] || s.gd_trang_thai}</dd>
            <dt>Ngày bắt đầu</dt><dd>{expStart}</dd>
            <dt>Ngày hết hạn</dt><dd><span className={"chip " + exp.cls}>{exp.label}</span></dd>
            <dt>Đã học / Tổng số buổi</dt><dd>{s.so_buoi_da_hoc ?? 0} / {s.sessions_total ?? "—"}</dd>
          </dl>
          {s.ghi_danh_id && <RenewForm ghiDanhId={s.ghi_danh_id} currentHetHan={s.ngay_het_han} currentTongSoBuoi={s.sessions_total} onDone={(patch) => setOverride((o) => ({ ...o, ...patch }))} />}
          {s.ghi_danh_id && <EnrollmentStatusActions ghiDanhId={s.ghi_danh_id} hocVienId={s.hoc_vien_id} studentName={s.name} lop={lop} gdTrangThai={s.gd_trang_thai} onDone={(patch) => setOverride((o) => ({ ...o, ...patch }))} />}
        </div>
        <div className="card">
          <h3>Học phí</h3>
          <dl>
            <dt>Học phí (dữ liệu cũ)</dt><dd>{s.fee ? fmtVnd(s.fee) : "—"}</dd>
            <dt>Tiền giáo cụ</dt><dd>{s.tien_giao_cu ? fmtVnd(s.tien_giao_cu) : "—"}</dd>
          </dl>
        </div>
        <PhuHuynhCard hocVienId={s.hoc_vien_id} wide />
      </div>
      {s.hoc_vien_id && (
        <p className="muted" style={{ marginTop: 10 }}>
          <a className="link" style={{ display: "inline" }} href={`#/hoc-vien/${encodeURIComponent(s.hoc_vien_id)}`}>Xem hồ sơ học viên (xuyên suốt các lớp) →</a>
        </p>
      )}
    </section>
  );
}

// Toàn bộ Học viên, kể cả chưa ghi danh vào lớp nào — trước đây chỉ xem học viên QUA từng Lớp, nên 1 học
// viên chưa xếp lớp hoàn toàn không hiện ở đâu cả (bắt thật lúc import danh sách học viên mới: vài em chưa
// kịp xếp lớp, cần có chỗ thấy họ để xếp lớp tiếp).
function StudentListPage() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  useEffect(() => { get("/api/candy/hoc-vien-ds").then(setRows); }, []);
  if (!rows) return <p className="muted">Đang tải…</p>;
  const qFold = foldVi(q);
  const filtered = rows.filter((r) => foldVi(r.name).includes(qFold));
  return (
    <section>
      <div className="bar">
        <input placeholder="Tìm học viên theo tên…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="pill">{filtered.length}/{rows.length} học viên</span>
      </div>
      <table>
        <thead><tr><th>Học viên</th><th>Ngày sinh</th><th>Cơ sở</th><th>Trạng thái</th><th>Lớp đang học</th></tr></thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.hoc_vien_id}>
              <td className="strong">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Avatar name={r.name} />
                  <a className="name-link" href={`#/hoc-vien/${encodeURIComponent(r.hoc_vien_id)}`}>{r.name}</a>
                </div>
              </td>
              <td>{fmt(r.ngay_sinh)}</td>
              <td>{CO_SO_LABEL[r.co_so] || r.co_so}</td>
              <td><StatusPill label={HV_STATUS[r.trang_thai] || r.trang_thai} tone={r.trang_thai === "dang_hoc" ? "ok" : ""} /></td>
              <td>{r.ghi_danh.length ? r.ghi_danh.map((g, i) => <span key={i} className="class-chip">{g.lop}</span>) : <span className="empty-chip">+ Chưa ghi danh</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// Hồ sơ học viên xuyên suốt nhiều lớp — key theo hoc_vien_id (record Học viên trên GHL), không theo lớp.
// Hiện mỗi học viên chỉ có 1 Ghi danh, nhưng cơ chế gom theo hoc_vien_id nên tự hỗ trợ nếu học viên
// từng/đang học nhiều lớp cùng lúc (ví dụ chuyển lớp mà vẫn giữ ghi danh cũ, hoặc học song song 2 lớp).
function StudentProfile({ hocVienId, back }) {
  const [d, setD] = useState(null);
  const load = () => get(`/api/candy/hoc-vien/${encodeURIComponent(hocVienId)}`).then(setD);
  useEffect(() => { setD(null); load(); }, [hocVienId]);
  if (!d) return <p className="muted">Đang tải…</p>;
  if (d.error) return <p className="muted">Không tìm thấy học viên.</p>;
  return (
    <section>
      <button className="link" onClick={back}>← Quay lại</button>
      <h2>{d.name}</h2>
      <p className="muted">{d.enrollments.length} ghi danh (hiện tại/lịch sử) trên {new Set(d.enrollments.map((e) => e.lop)).size} lớp</p>
      <div className="grid" style={{ marginTop: 12 }}>
        <PhuHuynhCard hocVienId={hocVienId} wide />
      </div>
      {d.enrollments.map((e) => {
        const exp = expiryInfo(e.ngay_het_han);
        return (
          <div className="card wide" key={e.n} style={{ marginTop: 12 }}>
            <h3>{e.lop} <span className="muted" style={{ fontWeight: 400 }}>· {CO_SO_LABEL[e.co_so] || e.co_so}</span></h3>
            <dl>
              <dt>Trạng thái ghi danh</dt><dd>{GD_STATUS[e.gd_trang_thai] || e.gd_trang_thai}</dd>
              <dt>Ngày bắt đầu</dt><dd>{e.ngay_bat_dau ? fmt(e.ngay_bat_dau) : "—"}</dd>
              <dt>Ngày hết hạn</dt><dd><span className={"chip " + exp.cls}>{exp.label}</span></dd>
              <dt>Đã học / Tổng số buổi</dt><dd>{e.so_buoi_da_hoc ?? 0} / {e.sessions_total ?? "—"}</dd>
            </dl>
            {e.ghi_danh_id && <RenewForm ghiDanhId={e.ghi_danh_id} currentHetHan={e.ngay_het_han} currentTongSoBuoi={e.sessions_total} onDone={load} />}
            {e.ghi_danh_id && <EnrollmentStatusActions ghiDanhId={e.ghi_danh_id} hocVienId={hocVienId} studentName={d.name} lop={e.lop} gdTrangThai={e.gd_trang_thai} onDone={load} />}
            <h3 style={{ marginTop: 14 }}>Lịch sử điểm danh</h3>
            {e.ghi_danh_id ? <AttendanceHistory ghiDanhId={e.ghi_danh_id} lop={e.lop} attendance={e.attendance} /> : (
              e.attendance.length === 0 ? <p className="muted">Chưa có lượt điểm danh nào.</p> : (
                <ul className="attention-list">
                  {e.attendance.map((a, i) => (
                    <li key={i}>{fmt(a.date)} — {STATUS_SHORT[a.status] || a.status}</li>
                  ))}
                </ul>
              )
            )}
          </div>
        );
      })}
    </section>
  );
}

const GV_TRANG_THAI = { dang_day: "Đang dạy", tam_nghi: "Tạm nghỉ", da_nghi: "Đã nghỉ" };

// Gán GV cho lớp — thay cho ô chữ tự do trước đây (chưa từng có UI, "field chết" thứ 3 phát hiện trong
// phiên này). Chọn từ danh sách giáo viên đã có, không gõ tay, để tránh gõ sai tên làm logic chặn trùng
// lịch dạy (so khớp theo chuỗi) không nhận ra 2 lớp thực ra cùng 1 GV.
function AssignTeacherForm({ lop, onDone, onCancel }) {
  const [list, setList] = useState(null);
  const [giaoVienId, setGiaoVienId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { get("/api/candy/giao-vien-list").then(setList); }, []);
  const submit = () => {
    if (!giaoVienId) { setErr("Chọn 1 giáo viên."); return; }
    setBusy(true); setErr("");
    fetch("/api/candy/lop-giao-vien", { method: "POST", body: JSON.stringify({ lop, giaoVienId }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } onDone(); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="card wide">
      <h3>Gán giáo viên — {lop}</h3>
      {!list ? <p className="muted">Đang tải…</p> : list.length === 0 ? (
        <p className="muted">Chưa có giáo viên nào. Qua tab "Giáo viên" để thêm trước.</p>
      ) : (
        <>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <select value={giaoVienId} onChange={(e) => setGiaoVienId(e.target.value)}>
              <option value="">— Chọn giáo viên —</option>
              {list.map((gv) => <option key={gv.id} value={gv.id}>{gv.name}{gv.soLopDangDay ? ` (đang dạy ${gv.soLopDangDay} lớp)` : ""}</option>)}
            </select>
          </div>
          <div className="row">
            <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang lưu…" : "Gán"}</button>
            <button onClick={onCancel} disabled={busy}>Huỷ</button>
          </div>
          {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
        </>
      )}
    </div>
  );
}

function AddGiaoVienForm({ onDone, onCancel }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = () => {
    if (!name.trim()) { setErr("Nhập tên giáo viên."); return; }
    setBusy(true); setErr("");
    fetch("/api/candy/giao-vien", { method: "POST", body: JSON.stringify({ name, phone, email }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } onDone(); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="card wide">
      <h3>Thêm giáo viên</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input placeholder="Tên giáo viên" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Điện thoại" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="row">
        <button className="primary" onClick={submit} disabled={busy}>{busy ? "Đang lưu…" : "Thêm"}</button>
        <button onClick={onCancel} disabled={busy}>Huỷ</button>
      </div>
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
    </div>
  );
}

function GiaoVienList({ openGiaoVien }) {
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => get("/api/candy/giao-vien-list").then(setList);
  useEffect(() => { load(); }, []);
  if (!list) return <p className="muted">Đang tải…</p>;
  return (
    <section>
      <div className="bar">
        <span className="pill">{list.length} giáo viên</span>
        <button className={adding ? "" : "primary"} onClick={() => setAdding((v) => !v)}>{adding ? "Đóng" : "+ Thêm giáo viên"}</button>
      </div>
      {adding && <AddGiaoVienForm onDone={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />}
      {list.length === 0 ? <p className="muted" style={{ marginTop: 12 }}>Chưa có giáo viên nào.</p> : (
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Tên</th><th>Điện thoại</th><th>Email</th><th>Trạng thái</th><th>Số lớp đang dạy</th></tr></thead>
          <tbody>
            {list.map((gv) => (
              <tr key={gv.id} onClick={() => openGiaoVien(gv.id)} style={{ cursor: "pointer" }}>
                <td className="strong">
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar name={gv.name} />
                    {gv.name}
                  </div>
                </td>
                <td>{gv.phone || "—"}</td>
                <td>{gv.email || "—"}</td>
                <td><StatusPill label={GV_TRANG_THAI[gv.trang_thai] || gv.trang_thai} tone={gv.trang_thai === "dang_day" ? "ok" : ""} /></td>
                <td>{gv.soLopDangDay > 0 ? gv.soLopDangDay : <span className="empty-chip">Chưa dạy lớp nào</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function GiaoVienStatusActions({ giaoVienId, trangThai, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const setStatus = (t) => {
    if (t === trangThai) return;
    setBusy(true); setErr("");
    fetch("/api/candy/giao-vien-sua", { method: "POST", body: JSON.stringify({ giaoVienId, trangThai: t }) })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => { if (!ok) { setErr(j.error || "Lỗi không rõ"); return; } onDone(); })
      .finally(() => setBusy(false));
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ marginTop: 0, flexWrap: "wrap" }}>
        {Object.entries(GV_TRANG_THAI).map(([k, label]) => (
          <button key={k} disabled={busy || k === trangThai} style={k === trangThai ? { opacity: .5 } : {}} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
    </div>
  );
}

function GiaoVienDetail({ giaoVienId, back, openLop }) {
  const [d, setD] = useState(null);
  const load = () => get(`/api/candy/giao-vien/${encodeURIComponent(giaoVienId)}`).then(setD);
  useEffect(() => { setD(null); load(); }, [giaoVienId]);
  if (!d) return <p className="muted">Đang tải…</p>;
  if (d.error) return <p className="muted">Không tìm thấy giáo viên.</p>;
  return (
    <section>
      <button className="link" onClick={back}>← Danh sách giáo viên</button>
      <h2>{d.name}</h2>
      <div className="grid" style={{ marginTop: 12 }}>
        <div className="card">
          <h3>Thông tin</h3>
          <dl>
            <dt>Điện thoại</dt><dd>{d.phone || "—"}</dd>
            <dt>Email</dt><dd>{d.email || "—"}</dd>
            <dt>Trạng thái</dt><dd>{GV_TRANG_THAI[d.trang_thai] || d.trang_thai}</dd>
          </dl>
          <GiaoVienStatusActions giaoVienId={d.id} trangThai={d.trang_thai} onDone={load} />
        </div>
        <div className="card">
          <h3>Ghi chú</h3>
          <p className="muted">{d.ghi_chu || "—"}</p>
        </div>
      </div>
      <div className="card wide" style={{ marginTop: 12 }}>
        <h3>Lớp đang dạy ({d.lops.length})</h3>
        {d.lops.length === 0 ? <p className="muted">Chưa dạy lớp nào — vào 1 lớp trong "Quản lý lớp" để gán.</p> : (
          <table>
            <thead><tr><th>Lớp</th><th>Cơ sở</th><th>Sĩ số</th><th>Lịch học</th></tr></thead>
            <tbody>
              {d.lops.map((l) => (
                <tr key={l.lop} onClick={() => openLop(l.lop)} style={{ cursor: "pointer" }}>
                  <td className="strong">{l.lop}</td>
                  <td>{CO_SO_LABEL[l.co_so] || l.co_so}</td>
                  <td>{l.siso}</td>
                  <td>{formatLichHoc(l) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function GiaoVienManagement() {
  const [gvId, setGvId] = useState(() => (location.hash.startsWith("#/giao-vien/") ? decodeURIComponent(location.hash.replace("#/giao-vien/", "")) : null));
  useEffect(() => {
    const h = () => setGvId(location.hash.startsWith("#/giao-vien/") ? decodeURIComponent(location.hash.replace("#/giao-vien/", "")) : null);
    window.addEventListener("hashchange", h); return () => window.removeEventListener("hashchange", h);
  }, []);
  if (gvId) return <GiaoVienDetail giaoVienId={gvId} back={() => { location.hash = "#/giao-vien"; }} openLop={(l) => { location.hash = `#/lop/${encodeURIComponent(l)}`; }} />;
  return <GiaoVienList openGiaoVien={(id) => { location.hash = `#/giao-vien/${encodeURIComponent(id)}`; }} />;
}

function ClassManagement() {
  const [lop, setLop] = useState(() => (location.hash.startsWith("#/lop/") ? decodeURIComponent(location.hash.replace("#/lop/", "")) : null));
  const [student, setStudent] = useState(null);
  useEffect(() => {
    const h = () => { setLop(location.hash.startsWith("#/lop/") ? decodeURIComponent(location.hash.replace("#/lop/", "")) : null); setStudent(null); };
    window.addEventListener("hashchange", h); return () => window.removeEventListener("hashchange", h);
  }, []);
  if (lop && student) return <StudentInClassDetail student={student} lop={lop} back={() => setStudent(null)} />;
  if (lop) return <ClassDetail lop={lop} back={() => { location.hash = "#/lop"; }} openStudent={setStudent} />;
  return <ClassList openLop={(l) => { location.hash = `#/lop/${encodeURIComponent(l)}`; }} />;
}

// Thời khoá biểu (Đợt "quản lý lớp còn thiếu gì" #2) — lưới 7 cột theo thứ, mỗi lớp là 1 dòng trong
// đúng cột thứ nó học, sắp theo giờ bắt đầu. Chỉ những lớp ĐÃ nhập lịch mới xuất hiện — không suy đoán,
// không bịa giờ cho lớp staff chưa từng nhập (giữ đúng dữ liệu thật).
const HOUR_PX = 56; // chiều cao 1 giờ trên lưới — đủ đọc được tên lớp + giờ trong khối 30-45 phút
const toMin = (t) => { const [h, m] = (t || "0:0").split(":").map(Number); return h * 60 + m; };
const JS_DAY_TO_THU = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"]; // Date.getDay(): 0=CN...6=T7

// Xếp các lớp trùng giờ trong cùng 1 ngày CẠNH NHAU (kiểu Google Calendar) thay vì đè lên nhau — 2 lớp
// khác giáo viên/phòng học trùng giờ là chuyện bình thường (server chỉ chặn khi TRÙNG GIÁO VIÊN lúc lưu),
// nên lưới phải tự xử lý được, không thể giả định "mỗi ngày tối đa 1 lớp mỗi giờ".
function layoutDay(classes) {
  const items = classes.map((c) => ({ c, s: toMin(c.gio_bat_dau), e: toMin(c.gio_ket_thuc) })).sort((a, b) => a.s - b.s);
  const colEnds = []; // colEnds[i] = giờ kết thúc buổi cuối cùng đã xếp vào cột i
  for (const it of items) {
    let col = colEnds.findIndex((end) => end <= it.s);
    if (col === -1) { col = colEnds.length; colEnds.push(it.e); } else colEnds[col] = it.e;
    it.col = col;
  }
  const totalCols = colEnds.length || 1;
  return items.map((it) => ({ ...it, totalCols }));
}

// Thời khoá biểu (chuẩn Google Calendar/Teachworks): lưới có TRỤC GIỜ thật — vị trí & chiều cao mỗi khối
// tỉ lệ với giờ bắt đầu/thời lượng, không phải danh sách xếp theo thứ tự chữ. Nhờ vậy nhìn 1 giây là biết
// buổi nào liền nhau, khoảng trống ở đâu, không phải đọc từng dòng chữ để tự tính trong đầu.
function ThoiKhoaBieu({ openLop }) {
  const [d, setD] = useState(null);
  const [coSo, setCoSo] = useState("");
  useEffect(() => { get("/api/candy/thoi-khoa-bieu").then(setD); }, []);
  if (!d) return <p className="muted">Đang tải…</p>;
  const all = Object.values(d.byThu).flat();
  if (all.length === 0) return (
    <section>
      <div className="alert-card" style={{ textAlign: "center", padding: "36px 20px", maxWidth: 420, margin: "24px auto" }}>
        <div className="alert-icon ok" style={{ margin: "0 auto 12px" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2.4" /><path d="M3 9.5h18" /><path d="M8 2.5v4M16 2.5v4" /></svg>
        </div>
        <p style={{ margin: 0, fontWeight: 600 }}>Chưa có lớp nào nhập lịch học</p>
        <p className="muted" style={{ marginTop: 6 }}>Vào "Quản lý lớp" → chọn 1 lớp → "+ Thêm lịch học" để bắt đầu.</p>
      </div>
    </section>
  );
  const coSoList = [...new Set(all.map((c) => c.co_so))];
  const filtered = coSo ? Object.fromEntries(d.thuOrder.map((t) => [t, d.byThu[t].filter((c) => c.co_so === coSo)])) : d.byThu;
  const shown = Object.values(filtered).flat();
  // Trục giờ mặc định 7:00-21:00 (giờ hoạt động điển hình của trung tâm), tự giãn nếu có lớp ngoài khung.
  const gridStart = Math.min(420, ...shown.map((c) => toMin(c.gio_bat_dau)));
  const gridEnd = Math.max(1260, ...shown.map((c) => toMin(c.gio_ket_thuc)));
  const startHour = Math.floor(gridStart / 60), endHour = Math.ceil(gridEnd / 60);
  const totalPx = (endHour - startHour) * HOUR_PX;
  const todayThu = JS_DAY_TO_THU[new Date().getDay()];
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  return (
    <section>
      <div className="tkb-toolbar">
        <select value={coSo} onChange={(e) => setCoSo(e.target.value)}>
          <option value="">Tất cả cơ sở</option>
          {coSoList.map((cs) => <option key={cs} value={cs}>{CO_SO_LABEL[cs] || cs}</option>)}
        </select>
        <div className="tkb-legend">
          {coSoList.map((cs) => <span key={cs}><span className="tkb-dot" style={{ background: CO_SO_COLOR[cs] || "var(--acc)" }} />{CO_SO_LABEL[cs] || cs}</span>)}
        </div>
      </div>
      <div className="tkb-wrap">
        <div className="tkb-grid">
          <div className="tkb-axis">
            <div style={{ height: 34 }} />
            {Array.from({ length: endHour - startHour }, (_, i) => (
              <div key={i} className="tkb-axis-slot" style={{ height: HOUR_PX }}><span>{String(startHour + i).padStart(2, "0")}:00</span></div>
            ))}
          </div>
          {d.thuOrder.map((t) => (
            <div key={t} className={"tkb-day" + (t === todayThu ? " today" : "")}>
              <div className="tkb-day-head">{d.thuLabel[t]}</div>
              <div style={{ position: "relative", height: totalPx }}>
                {Array.from({ length: endHour - startHour + 1 }, (_, i) => (
                  <div key={i} className="tkb-hourline" style={{ top: i * HOUR_PX }} />
                ))}
                {t === todayThu && nowMin >= gridStart && nowMin <= gridEnd && (
                  <div style={{ position: "absolute", left: 0, right: 0, top: ((nowMin - gridStart) / 60) * HOUR_PX, borderTop: "2px solid var(--bad)", zIndex: 2 }} />
                )}
                {layoutDay(filtered[t]).map(({ c, s, e, col, totalCols }) => {
                  const top = ((s - gridStart) / 60) * HOUR_PX, h = Math.max(((e - s) / 60) * HOUR_PX, 30);
                  const wPct = 100 / totalCols;
                  return (
                    <div key={c.lop} className="tkb-block"
                      style={{ top, height: h, left: `calc(${col * wPct}% + 2px)`, width: `calc(${wPct}% - 4px)`, background: CO_SO_COLOR[c.co_so] || "var(--acc)" }}
                      onClick={() => openLop(c.lop)} title={`${c.lop} · ${c.gio_bat_dau}-${c.gio_ket_thuc}${c.giao_vien ? " · " + c.giao_vien : ""}`}>
                      <span className="strong">{c.lop}</span>
                      <span className="tkb-sub">{c.gio_bat_dau}-{c.gio_ket_thuc}{c.giao_vien ? ` · ${c.giao_vien}` : ""} · {c.siso} hv</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const ROLE_LABEL = { admin: "Quản lý", staff: "Nhân viên" };

// Quản lý nhân sự (đăng nhập qua GHL Custom Menu Link): danh sách email được phép vào app + vai trò của
// từng người. Chỉ admin xem/sửa được (route staff-* đã chặn quyền ở server, đây chỉ là UI). Không cho tự
// xoá chính mình (chặn cả 2 phía, xem server.mjs) — tránh 1 quản lý lỡ tay khoá quyền của chính mình.
function StaffManagement({ me, brand }) {
  const [list, setList] = useState(null);
  const [form, setForm] = useState({ email: "", name: "", role: "staff" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => get("/api/candy/staff-list").then((d) => setList(Array.isArray(d) ? d : []));
  useEffect(() => { load(); }, []);
  const add = async () => {
    if (!form.email.trim()) return;
    setBusy(true); setErr("");
    const r = await fetch("/api/candy/staff-add", { method: "POST", body: JSON.stringify(form) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) { setErr(j.error || "Lỗi không rõ"); return; }
    setForm({ email: "", name: "", role: "staff" }); load();
  };
  const setRole = async (email, role) => {
    await fetch("/api/candy/staff-role", { method: "POST", body: JSON.stringify({ email, role }) });
    load();
  };
  const remove = async (email) => {
    if (!confirm(`Bỏ quyền truy cập của ${email}?`)) return;
    await fetch("/api/candy/staff-remove", { method: "POST", body: JSON.stringify({ email }) });
    load();
  };
  if (!list) return <p className="muted">Đang tải…</p>;
  return (
    <div className="card wide">
      <h3>Phân quyền nhân viên</h3>
      <p className="muted">Email phải khớp đúng email Google/GHL của người đó — khi họ bấm menu "{brand.menuLabel}" trong GHL, hệ thống tra theo email này để cho vào.</p>
      <table style={{ marginTop: 10 }}>
        <thead><tr><th>Email</th><th>Tên</th><th>Vai trò</th><th></th></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.email} style={{ cursor: "default" }}>
              <td>{s.email}{s.email === me?.email && <span className="pill" style={{ marginLeft: 6 }}>Bạn</span>}</td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <Avatar name={s.name || s.email} size="sm" />
                  {s.name}
                </div>
              </td>
              <td>
                <select value={s.role} onChange={(e) => setRole(s.email, e.target.value)} disabled={s.email === me?.email}>
                  <option value="staff">Nhân viên</option>
                  <option value="admin">Quản lý</option>
                </select>
              </td>
              <td>{s.email !== me?.email && <button className="link" onClick={() => remove(s.email)}>Xoá</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 14 }}>
        <input placeholder="Email nhân viên mới" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input placeholder="Tên hiển thị" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="staff">Nhân viên</option>
          <option value="admin">Quản lý</option>
        </select>
        <button className="primary" onClick={add} disabled={busy}>+ Thêm nhân viên</button>
      </div>
      {err && <p style={{ color: "var(--bad)" }}>{err}</p>}
    </div>
  );
}

// Đợt 4 — Quy tắc học bù. Chỉ phần "số buổi tối đa" + "loại vắng được bù" là do chủ trung tâm quyết định
// và có thể đổi ý, nên để admin chỉnh trong UI (lưu server-side, KHÔNG hardcode). "Học bù ở lớp khác cùng
// cấp độ" và "hạn dùng = ngày hết hạn gói" là quy tắc đã chốt cố định — hiện rõ để ai cũng biết, không cho sửa
// bừa vì đổi 2 quy tắc này ảnh hưởng thiết kế Buổi học/Điểm danh, không chỉ là 1 con số.
function ConfigPage({ me, brand }) {
  const [cfg, setCfg] = useState(null);
  const [saved, setSaved] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { get("/api/candy/config").then(setCfg); }, []);
  if (!cfg) return <p className="muted">Đang tải…</p>;
  const toggleLoai = (key) => {
    const has = cfg.hoc_bu.loai_vang_duoc_bu.includes(key);
    const loai = has ? cfg.hoc_bu.loai_vang_duoc_bu.filter((x) => x !== key) : [...cfg.hoc_bu.loai_vang_duoc_bu, key];
    setCfg({ hoc_bu: { ...cfg.hoc_bu, loai_vang_duoc_bu: loai } });
  };
  const save = async () => {
    setErr(""); setSaved("");
    const r = await fetch("/api/candy/config", { method: "POST", body: JSON.stringify(cfg) });
    const j = await r.json();
    if (!r.ok) { setErr(j.error || "Lỗi không rõ"); return; }
    setCfg(j); setSaved("Đã lưu.");
  };
  return (
    <section>
      <StaffManagement me={me} brand={brand} />
      <div className="card wide" style={{ marginTop: 14 }}>
        <h3>Quy tắc học bù</h3>
        <p className="muted">Áp dụng khi 1 học viên vắng 1 buổi và muốn xếp học bù buổi khác.</p>
        <div style={{ marginTop: 14 }}>
          <label style={{ display: "block", marginBottom: 6 }}>Số buổi học bù tối đa mỗi kỳ ghi danh</label>
          <input type="number" min="0" max="20" value={cfg.hoc_bu.so_buoi_toi_da}
            onChange={(e) => setCfg({ hoc_bu: { ...cfg.hoc_bu, so_buoi_toi_da: Number(e.target.value) } })} style={{ width: 100 }} />
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={{ display: "block", marginBottom: 6 }}>Loại vắng được học bù</label>
          <label style={{ marginRight: 16 }}>
            <input type="checkbox" checked={cfg.hoc_bu.loai_vang_duoc_bu.includes("vang_co_phep")} onChange={() => toggleLoai("vang_co_phep")} /> Vắng có phép
          </label>
          <label>
            <input type="checkbox" checked={cfg.hoc_bu.loai_vang_duoc_bu.includes("vang_khong_phep")} onChange={() => toggleLoai("vang_khong_phep")} /> Vắng không phép
          </label>
        </div>
        <div className="row">
          <button className="primary" onClick={save}>Lưu</button>
          {saved && <span className="hint">{saved}</span>}
          {err && <span style={{ color: "var(--bad)" }}>{err}</span>}
        </div>
      </div>
      <div className="card wide" style={{ marginTop: 14 }}>
        <h3>Quy tắc cố định (đã chốt, không chỉnh qua đây)</h3>
        <dl>
          <dt>Học bù ở lớp nào</dt><dd>Lớp khác cùng <strong>cấp độ</strong> (không bắt buộc học đúng lớp gốc)</dd>
          <dt>Hạn dùng buổi học bù</dt><dd>Trước <strong>ngày hết hạn gói học</strong> của học viên</dd>
        </dl>
        <p className="muted" style={{ marginTop: 8 }}>Đổi 2 quy tắc này ảnh hưởng cách thiết kế Buổi học/Điểm danh, không chỉ là 1 con số — cần bàn lại thay vì tự sửa ở đây.</p>
      </div>
    </section>
  );
}

function StatCard({ label, value, sub }) {
  return <div className="card stat"><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub && <div className="muted stat-sub">{sub}</div>}</div>;
}

function OkIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 12.5l2.5 2.5L16 9" /></svg>;
}
function WarnIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 2 20h20L12 3Z" /><path d="M12 9.5v5" /><circle cx="12" cy="17.3" r=".3" fill="currentColor" /></svg>;
}
// Thẻ cảnh báo cho "Cần chú ý hôm nay" — thay bảng 2 cột chữ phẳng cũ: icon + màu theo mức độ, đếm số lượng
// ở góc, trạng thái rỗng tích cực (dấu tích xanh) thay vì chỉ 1 dòng "Không có." xám.
function AlertCard({ icon, title, count, children }) {
  return (
    <div className={`alert-card ${icon === "warn" ? "warn" : ""}`}>
      <div className="alert-card-head">
        <div className={`alert-icon ${icon}`}>{icon === "warn" ? <WarnIcon /> : <OkIcon />}</div>
        <div className="alert-title">{title}</div>
        {count > 0 && <div className="alert-count">{count}</div>}
      </div>
      {children}
    </div>
  );
}

// Thanh ngang đơn giản (CSS thuần, không cần thư viện) — nhìn phát biết tỉ lệ tương đối, thay vì phải đọc
// từng số trong danh sách phẳng. max = giá trị lớn nhất trong nhóm nên thanh dài nhất luôn đầy 100%.
function BarRow({ label, value, max, color }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
        <span>{label}</span><span className="strong" style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      <div style={{ background: "var(--bg)", borderRadius: 6, height: 8, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color || "var(--acc)", borderRadius: 6 }} />
      </div>
    </div>
  );
}

const ATT_STATUS_COLOR = { co_mat: "var(--ok)", den_muon: "var(--warn)", vang_co_phep: "var(--warn)", vang_khong_phep: "var(--bad)" };

function Dashboard() {
  const [d, setD] = useState(null);
  useEffect(() => { get("/api/candy/dashboard").then(setD); }, []);
  if (!d) return <p className="muted">Đang tải…</p>;
  const attTotal = d.attendance.real + d.attendance.demo;
  const absentRate = attTotal ? Math.round((d.attendance.absentCount / attTotal) * 100) : 0;
  const coSoMax = Math.max(1, ...Object.values(d.byCoSo));
  const statusMax = Math.max(1, ...Object.values(d.attendance.statusCount));
  return (
    <section>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <StatCard label="Học viên" value={d.totalStudents} sub={`${d.classesWithStudents}/${d.totalClasses} lớp có học viên`} />
        <StatCard label="Lượt điểm danh" value={attTotal} sub={d.attendance.demo > 0 ? `${d.attendance.demo} chưa đồng bộ` : "đã lưu đầy đủ"} />
        <StatCard label="Tỷ lệ vắng" value={`${absentRate}%`} sub={`trên ${attTotal} lượt điểm danh`} />
        <StatCard label="Học bù đã đặt" value={d.tongHocBuDaDat} sub="lượt đặt lịch học bù thực tế" />
      </div>
      {(
        <>
          <h3 style={{ marginBottom: 14 }}>Cần chú ý hôm nay</h3>
          <div className="alert-grid" style={{ marginBottom: 20 }}>
            <AlertCard icon="ok" title="Sắp hết hạn / đã hết hạn gói học">
              {d.expiringSoon.length === 0 ? <div className="alert-ok-msg"><OkIcon /> Mọi gói học đều ổn.</div> : (
                <>
                  {d.expiringSoon.slice(0, 3).map((x, i) => {
                    const warn = x.daysLeft < 0;
                    const label = warn ? `Hết hạn ${Math.abs(x.daysLeft)} ngày trước` : x.daysLeft === 0 ? "Hết hạn hôm nay" : `Còn ${x.daysLeft} ngày`;
                    return (
                      <div className="alert-row" key={i}>
                        <a href={`#/hoc-vien/${encodeURIComponent(x.hoc_vien_id)}`} className="name-link">{x.name}</a>
                        <span className={`chip ${warn ? "chip-bad" : "chip-warn"}`}>{label}</span>
                      </div>
                    );
                  })}
                  {d.expiringSoon.length > 3 && <span className="alert-more">+{d.expiringSoon.length - 3} học viên khác</span>}
                </>
              )}
            </AlertCard>
            <AlertCard icon="ok" title="Vắng liên tiếp ≥2 buổi gần nhất">
              {d.absentStreak.length === 0 ? <div className="alert-ok-msg"><OkIcon /> Không ai vắng liên tiếp.</div> : (
                <>
                  {d.absentStreak.slice(0, 3).map((x, i) => (
                    <div className="alert-row" key={i}>
                      <a href={`#/hoc-vien/${encodeURIComponent(x.hoc_vien_id)}`} className="name-link">{x.name}</a>
                      <span className="chip chip-bad">{x.streak} buổi liên tiếp</span>
                    </div>
                  ))}
                  {d.absentStreak.length > 3 && <span className="alert-more">+{d.absentStreak.length - 3} học viên khác</span>}
                </>
              )}
            </AlertCard>
            <AlertCard icon="warn" title="Lớp có học viên nhưng chưa gán giáo viên" count={d.lopChuaCoGV.length}>
              {d.lopChuaCoGV.length === 0 ? <div className="alert-ok-msg"><OkIcon /> Lớp nào cũng đã có giáo viên.</div> : (
                <>
                  {d.lopChuaCoGV.slice(0, 3).map((lop) => (
                    <div className="alert-row" key={lop}>
                      <a href={`#/lop/${encodeURIComponent(lop)}`} className="name-link">{lop}</a>
                      <a href={`#/lop/${encodeURIComponent(lop)}`} style={{ fontSize: 12.5, fontWeight: 600 }}>Gán giáo viên →</a>
                    </div>
                  ))}
                  {d.lopChuaCoGV.length > 3 && <span className="alert-more">+{d.lopChuaCoGV.length - 3} lớp khác</span>}
                </>
              )}
            </AlertCard>
            <AlertCard icon="warn" title="Lớp có học viên nhưng chưa nhập lịch học" count={d.lopChuaCoLich.length}>
              {d.lopChuaCoLich.length === 0 ? <div className="alert-ok-msg"><OkIcon /> Lớp nào cũng đã có lịch.</div> : (
                <>
                  {d.lopChuaCoLich.slice(0, 3).map((lop) => (
                    <div className="alert-row" key={lop}>
                      <a href={`#/lop/${encodeURIComponent(lop)}`} className="name-link">{lop}</a>
                      <a href={`#/lop/${encodeURIComponent(lop)}`} style={{ fontSize: 12.5, fontWeight: 600 }}>Nhập lịch →</a>
                    </div>
                  ))}
                  {d.lopChuaCoLich.length > 3 && <span className="alert-more">+{d.lopChuaCoLich.length - 3} lớp khác</span>}
                </>
              )}
            </AlertCard>
          </div>
        </>
      )}
      <div className="card wide" style={{ marginBottom: 14 }}>
        <h3>Hôm nay · {d.thuLabel[d.todayThu]}</h3>
        {d.todaySessions.length === 0 ? (
          <p className="muted">Không có buổi học nào theo lịch đã nhập cho hôm nay.</p>
        ) : (
          <table>
            <thead><tr><th>Giờ</th><th>Lớp</th><th>Cơ sở</th><th>Giáo viên</th><th>Sĩ số</th></tr></thead>
            <tbody>
              {d.todaySessions.map((s) => (
                <tr key={s.lop} onClick={() => { location.hash = `#/lop/${encodeURIComponent(s.lop)}`; }} style={{ cursor: "pointer" }}>
                  <td className="strong">{s.gio_bat_dau}-{s.gio_ket_thuc}</td>
                  <td>{s.lop}</td>
                  <td>{CO_SO_LABEL[s.co_so] || s.co_so}</td>
                  <td className={s.giao_vien ? "" : "muted"}>{s.giao_vien || "Chưa gán"}</td>
                  <td>{s.siso}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="grid" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Học viên theo cơ sở</h3>
          {Object.entries(d.byCoSo).map(([k, v]) => <BarRow key={k} label={CO_SO_LABEL[k] || k} value={v} max={coSoMax} />)}
        </div>
        <div className="card">
          <h3>Trạng thái điểm danh</h3>
          {Object.entries(d.attendance.statusCount).map(([k, v]) => <BarRow key={k} label={STATUS_SHORT[k] || k} value={v} max={statusMax} color={ATT_STATUS_COLOR[k]} />)}
        </div>
        <div className="card wide">
          <h3>Tổng học phí</h3>
          <div className="stat-value">{fmtVnd(d.totalPhi)}</div>
        </div>
      </div>
    </section>
  );
}

// Icon set cho thanh điều hướng — vẽ tay bằng path đơn giản (stroke, không phụ thuộc font/thư viện icon
// ngoài) để mỗi tab có 1 tín hiệu hình ảnh riêng, dễ nhận ra hơn là chỉ có chữ khi thu nhỏ màn hình.
const NAV_ICON = {
  khach: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="5" r="2.6" /><path d="M2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5" /></svg>,
  lop: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="5" height="5" rx="1.1" /><rect x="9" y="2" width="5" height="5" rx="1.1" /><rect x="2" y="9" width="5" height="5" rx="1.1" /><rect x="9" y="9" width="5" height="5" rx="1.1" /></svg>,
  "giao-vien": <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M1.3 6.3 8 3l6.7 3.3L8 9.6 1.3 6.3Z" /><path d="M4.3 7.8v3c0 1.1 1.7 2 3.7 2s3.7-.9 3.7-2v-3" /><path d="M14 6.7v3.6" /></svg>,
  "thoi-khoa-bieu": <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="12" height="11" rx="1.6" /><path d="M2 6.5h12" /><path d="M5 1.5v3M11 1.5v3" /></svg>,
  "diem-danh": <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.3" /><path d="M5.2 8.2 7.1 10l3.5-4.3" /></svg>,
  "bao-cao": <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13V8M8 13V4M13 13v-3" /></svg>,
  "cau-hinh": <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 4h12M2 8h12M2 12h12" /><circle cx="10" cy="4" r="1.6" fill="var(--card)" /><circle cx="5" cy="8" r="1.6" fill="var(--card)" /><circle cx="11" cy="12" r="1.6" fill="var(--card)" /></svg>,
};

// Màn hình chặn khi chưa đăng nhập (hoặc session vừa bị huỷ, VD sau khi bấm Đăng xuất) — bình thường
// server đã tự chặn từ đầu (không phục vụ index.html nếu chưa có cookie), màn này chỉ lộ ra khi 1 phiên
// ĐANG MỞ SẴN trong trình duyệt bỗng hết hạn/bị đăng xuất và app gọi /api/candy/me lại thấy 401.
function AccessGate({ brand, msg }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
      <div style={{ maxWidth: 380, padding: 32, textAlign: "center" }}>
        <span className="brand-mark" style={{ display: "inline-flex", marginBottom: 16 }}>{brand.brandMark}</span>
        <h2 style={{ margin: "0 0 8px" }}>Chưa đăng nhập</h2>
        <p className="muted">{msg}</p>
      </div>
    </div>
  );
}

// Giá trị mặc định trong lúc /api/branding chưa tải xong — chỉ để tránh màn hình trống 1 nhịp, không phải
// nguồn sự thật. Từ đợt multi-tenant: nguồn thật là bảng platform.tenants trên Postgres (1 dòng/trung tâm),
// không còn là 1 file JSON tĩnh trên server nữa — server tự trả đúng thương hiệu của trung tâm đang đăng nhập.
const DEFAULT_BRAND = { brandName: "…", brandMark: "··", orgLabel: "…", menuLabel: "…", khachHangEnabled: false };

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = đang tải, null = chưa đăng nhập, object = đã đăng nhập
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [ssoError, setSsoError] = useState("");
  const [coSoReady, setCoSoReady] = useState(false);
  // Nạp danh sách cơ sở của trung tâm ngay khi biết đã đăng nhập, TRƯỚC khi vẽ giao diện chính — để không có
  // nhịp nào hiện mã thô (vd "quan_nam") rồi mới đổi sang tên thật.
  useEffect(() => {
    if (!me) return;
    get("/api/candy/co-so").then((d) => { applyCoSoOptions(d.options || []); }).catch(() => {}).finally(() => setCoSoReady(true));
  }, [me]);
  useEffect(() => { get("/api/branding").then((b) => { if (b && b.brandName) { setBrand(b); document.title = `${b.brandName} · Vận hành`; } }); }, []);
  useEffect(() => {
    (async () => {
      // Tầng 2 (Custom Page trong Marketplace App, mạnh hơn Tầng 1 Custom Menu Link): nếu đang chạy trong
      // iframe và chưa có token sẵn, hỏi xin dữ liệu người dùng đã mã hoá từ cửa sổ cha (chính GHL) qua
      // postMessage — GHL sinh gói dữ liệu MỚI mỗi lần, gửi lên server tự giải mã, không đi qua URL nên
      // không có chuyện "chép URL cũ dùng lại" như Tầng 1. Bỏ qua bước này nếu đã có token (đăng nhập rồi)
      // hoặc không nằm trong iframe nào (postMessage tới chính mình không bao giờ có ai trả lời, timeout).
      const ssoLogin = async () => {
        try {
          const encryptedData = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("GHL không phản hồi")), 3000);
            const onMsg = ({ data }) => {
              if (data && data.message === "REQUEST_USER_DATA_RESPONSE") {
                clearTimeout(t); window.removeEventListener("message", onMsg); resolve(data.payload);
              }
            };
            window.addEventListener("message", onMsg);
            window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
          });
          const r = await fetch("/api/candy/sso-verify", { method: "POST", body: JSON.stringify({ encryptedData }) });
          const j = await r.json();
          if (r.ok && j.token) { localStorage.setItem(TOKEN_KEY, j.token); return ""; }
          return j.error || "Đăng nhập qua GHL thất bại";
        } catch (e) { return e.message || "Không lấy được dữ liệu từ GHL"; /* không nằm trong GHL, hoặc GHL chưa phản hồi kịp */ }
      };
      const inFrame = window.parent !== window;
      // Bug thật (bắt được sau đợt multi-tenant): trước đây chỉ thử SSO khi CHƯA có token nào trong localStorage.
      // Token cũ (đã bị server xoá/không còn hợp lệ — ví dụ phiên tạo trước khi đổi chỗ lưu session) vẫn nằm đó,
      // nên SSO không bao giờ chạy lại và người dùng kẹt ở "Chưa đăng nhập" dù đang là admin. Giờ: có token thì
      // kiểm tra trước, server từ chối thì xoá token đó đi rồi thử SSO lại như chưa từng đăng nhập.
      //
      // Bug thật THỨ HAI (bắt được 2026-10-12, lúc test cài đặt cấp agency): localStorage dùng CHUNG 1 origin
      // cho MỌI trung tâm (1 frontend phục vụ tất cả khách hàng) — "token còn hợp lệ" chỉ có nghĩa là phiên
      // đăng nhập CŨ chưa hết hạn, KHÔNG có nghĩa nó thuộc đúng trung tâm đang mở. Mở Custom Page của trung
      // tâm B trong cùng trình duyệt đã từng đăng nhập trung tâm A trước đó → vẫn thấy dữ liệu của A. Ở Tầng 2
      // (trong iframe GHL), GHL luôn gửi lại ĐÚNG context của trang đang mở qua postMessage mỗi lần — nên phải
      // luôn tin SSO hơn token cũ, không được bỏ qua SSO chỉ vì đã có 1 token "hợp lệ" sẵn.
      let ssoError = "";
      if (inFrame) {
        ssoError = await ssoLogin();
        if (ssoError && localStorage.getItem(TOKEN_KEY)) {
          // GHL không phản hồi kịp qua postMessage (mạng chậm, hoặc hiếm khi không chạy trong Custom Page
          // thật) — tạm dùng token cũ nếu nó còn hợp lệ, thay vì chặn hẳn người dùng ở "Chưa đăng nhập".
          const check = await get("/api/candy/me").catch(() => null);
          if (check && check.email) ssoError = ""; else localStorage.removeItem(TOKEN_KEY);
        }
      } else if (localStorage.getItem(TOKEN_KEY)) {
        const check = await get("/api/candy/me").catch(() => null);
        if (!(check && check.email)) localStorage.removeItem(TOKEN_KEY);
      }
      // Đợt multi-tenant: lần gọi /api/branding lúc mount (trên) chạy TRƯỚC khi biết token của Tầng 2 (vừa
      // set ở trên, nếu có) nên chỉ thấy được thương hiệu chung chung. Gọi lại 1 lần nữa ở đây — giờ đã có
      // token (Tầng 1 lẫn Tầng 2 đều xong) — để đổi sang đúng tên/logo của trung tâm vừa đăng nhập vào.
      get("/api/branding").then((b) => { if (b && b.brandName) { setBrand(b); document.title = `${b.brandName} · Vận hành`; } });
      get("/api/candy/me").then((d) => { setSsoError(ssoError); setMe(d && d.email ? d : null); });
    })();
  }, []);
  const logout = async () => { await fetch("/api/candy/logout", { method: "POST" }); localStorage.removeItem(TOKEN_KEY); setMe(null); };
  const [mask, setMask] = useState(true);
  // Mặc định về "bao-cao" (không phải "khach" nữa) — module Khách hàng (demo 123 GYM) không tồn tại trên
  // bản deploy thật (data/contacts.json không đi kèm code, xem server.mjs), nên trang mặc định phải là
  // trang luôn có sẵn ở mọi nơi deploy, không riêng máy cục bộ.
  const [page, setPage] = useState(() => (
    location.hash.startsWith("#/diem-danh") ? "diem-danh" : location.hash.startsWith("#/lop") ? "lop" : location.hash.startsWith("#/bao-cao") ? "bao-cao" : location.hash.startsWith("#/hoc-vien/") ? "hoc-vien" : location.hash.startsWith("#/danh-sach-hoc-vien") ? "hoc-vien-ds" : location.hash.startsWith("#/cau-hinh") ? "cau-hinh" : location.hash.startsWith("#/thoi-khoa-bieu") ? "thoi-khoa-bieu" : location.hash.startsWith("#/giao-vien") ? "giao-vien" : location.hash.startsWith("#/khach") ? "khach" : "bao-cao"
  ));
  const [id, setId] = useState(() => location.hash.replace("#/khach/", "") || null);
  const [hvId, setHvId] = useState(() => (location.hash.startsWith("#/hoc-vien/") ? decodeURIComponent(location.hash.replace("#/hoc-vien/", "")) : null));
  useEffect(() => {
    const h = () => {
      if (location.hash.startsWith("#/diem-danh")) { setPage("diem-danh"); setId(null); }
      else if (location.hash.startsWith("#/lop")) { setPage("lop"); setId(null); }
      else if (location.hash.startsWith("#/bao-cao")) { setPage("bao-cao"); setId(null); }
      else if (location.hash.startsWith("#/cau-hinh")) { setPage("cau-hinh"); setId(null); }
      else if (location.hash.startsWith("#/thoi-khoa-bieu")) { setPage("thoi-khoa-bieu"); setId(null); }
      else if (location.hash.startsWith("#/giao-vien")) { setPage("giao-vien"); setId(null); }
      else if (location.hash.startsWith("#/hoc-vien/")) { setPage("hoc-vien"); setHvId(decodeURIComponent(location.hash.replace("#/hoc-vien/", ""))); }
      else if (location.hash.startsWith("#/danh-sach-hoc-vien")) { setPage("hoc-vien-ds"); setId(null); }
      else { setPage("khach"); setId(location.hash.startsWith("#/khach/") ? location.hash.replace("#/khach/", "") : null); }
    };
    window.addEventListener("hashchange", h); return () => window.removeEventListener("hashchange", h);
  }, []);
  const open = (i) => { location.hash = `#/khach/${i}`; };
  const TITLES = { "diem-danh": "Điểm danh", lop: "Quản lý lớp", "bao-cao": "Báo cáo tổng quan", khach: "Khách hàng", "hoc-vien": "Hồ sơ học viên", "hoc-vien-ds": "Học viên", "cau-hinh": "Cấu hình", "thoi-khoa-bieu": "Thời khoá biểu", "giao-vien": "Giáo viên" };
  const SUBS = {
    "diem-danh": `${brand.orgLabel} · điểm danh theo lớp`,
    lop: `${brand.orgLabel} · danh sách lớp và học viên`,
    "bao-cao": `${brand.orgLabel} · tổng quan hoạt động`,
    khach: "123 GYM Bạch Đằng · bản demo, dữ liệu chỉ nằm trên máy này", // module riêng, không thuộc thương hiệu trên — không đổi theo tenant
    "hoc-vien": `${brand.orgLabel} · xuyên suốt mọi lớp học viên từng/đang học`,
    "hoc-vien-ds": `${brand.orgLabel} · toàn bộ học viên, kể cả chưa ghi danh lớp`,
    "cau-hinh": `${brand.orgLabel} · quy tắc do trung tâm quyết định`,
    "thoi-khoa-bieu": `${brand.orgLabel} · chỉ hiện lớp đã nhập lịch`,
    "giao-vien": `${brand.orgLabel} · hồ sơ + lớp đang dạy`,
  };
  const NAV = [
    // Module demo 123 GYM — chỉ hiện khi server thật sự có data/contacts.json (chỉ đúng trên máy cục bộ,
    // không có trên bản deploy thật vì data/ bị loại khỏi git hoàn toàn — xem server.mjs).
    ...(brand.khachHangEnabled ? [{ key: "khach", href: "#/", label: "Khách hàng" }] : []),
    { key: "lop", href: "#/lop", label: "Quản lý lớp" },
    { key: "hoc-vien-ds", href: "#/danh-sach-hoc-vien", label: "Học viên" },
    { key: "giao-vien", href: "#/giao-vien", label: "Giáo viên" },
    { key: "thoi-khoa-bieu", href: "#/thoi-khoa-bieu", label: "Thời khoá biểu" },
    { key: "diem-danh", href: "#/diem-danh", label: "Điểm danh" },
    { key: "bao-cao", href: "#/bao-cao", label: "Báo cáo" },
    // Cấu hình chứa quy tắc nghiệp vụ + quản lý nhân sự — chỉ admin mới cần thấy trong menu (server vẫn
    // là lớp chặn thật sự cho các thao tác ghi; ẩn ở đây chỉ để đỡ rối cho nhân viên không dùng tới).
    ...(me?.role === "admin" ? [{ key: "cau-hinh", href: "#/cau-hinh", label: "Cấu hình" }] : []),
  ];
  if (me === undefined) return <p className="muted" style={{ padding: 40 }}>Đang tải…</p>;
  if (me && !coSoReady) return <p className="muted" style={{ padding: 40 }}>Đang tải…</p>;
  if (me === null) return <AccessGate brand={brand} msg={ssoError || `Vui lòng vào GHL và bấm menu "${brand.menuLabel}" để truy cập.`} />;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-row">
          <span className="brand"><span className="brand-mark">{brand.brandMark}</span>{brand.brandName}</span>
          <div className="topbar-actions">
            {page === "khach" && <label><input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} /> Che thông tin cá nhân</label>}
            <span className="muted">{me.name} · {ROLE_LABEL[me.role] || me.role}</span>
            <button className="link" onClick={logout}>Đăng xuất</button>
          </div>
        </div>
        <nav className="tabs">
          {NAV.map((n) => (
            <a key={n.key} className={"tab" + (page === n.key ? " on" : "")} href={n.href}>{NAV_ICON[n.key]}{n.label}</a>
          ))}
        </nav>
      </header>
      <main className="content">
        <div className="page-head">
          <h1>{TITLES[page]}</h1>
          <p>{SUBS[page]}</p>
        </div>
        {page === "diem-danh" ? <Attendance />
          : page === "lop" ? <ClassManagement />
          : page === "bao-cao" ? <Dashboard />
          : page === "hoc-vien" ? <StudentProfile hocVienId={hvId} back={() => { location.hash = "#/bao-cao"; }} />
          : page === "hoc-vien-ds" ? <StudentListPage />
          : page === "cau-hinh" ? (me.role === "admin" ? <ConfigPage me={me} brand={brand} /> : <p className="muted">Chỉ quản lý mới xem được trang này.</p>)
          : page === "thoi-khoa-bieu" ? <ThoiKhoaBieu openLop={(l) => { location.hash = `#/lop/${encodeURIComponent(l)}`; }} />
          : page === "giao-vien" ? <GiaoVienManagement />
          : !brand.khachHangEnabled ? <p className="muted">Module Khách hàng (demo 123 GYM) không có trên bản này.</p>
          : id ? <Profile id={id} mask={mask} back={() => { location.hash = ""; }} /> : <List mask={mask} open={open} />}
      </main>
    </div>
  );
}
