// Đăng nhập/phân quyền dựa trên GHL Custom Menu Link (Tầng 1) + Custom Page trong Marketplace App (Tầng 2):
// khi 1 nhân viên bấm menu/mở trang trong GHL, GHL tự cho biết email thật của người đang bấm — nghĩa là
// GHL đã xác thực họ trước rồi, mình chỉ cần tra trong danh sách nhân viên đã cấp quyền rồi cấp 1 session
// token cho họ. Danh sách nhân viên + session giờ lưu ở Postgres (xem db.mjs) thay vì file JSON cục bộ —
// file cục bộ sẽ mất khi Render redeploy (ổ đĩa không bền), Postgres thì không.
// Session dùng qua header Authorization: Bearer (không phải cookie) — xem lý do ở server.mjs: GHL luôn
// nhúng qua iframe trên chính domain của GHL, cookie đặt từ bên trong iframe bên-thứ-ba bị trình duyệt
// hiện đại âm thầm chặn, token qua localStorage thì không.
// Tầng 1 (chỉ tin ?email= trên URL, không ký/mã hoá) đủ tin cậy cho công cụ nội bộ nhưng không chống được
// người đã có quyền mở menu cố tình dò — đã vá thêm 1 lớp bằng khoá CML_KEY (xem getCmlKey). Tầng 2 (Custom
// Page, payload mã hoá AES mới mỗi lần mở) mạnh hơn hẳn — ưu tiên dùng khi có thể, Tầng 1 giữ lại làm dự phòng.
import fs from "fs";
import crypto from "crypto";
import CryptoJS from "crypto-js";
export { findStaff, listStaff, addStaff, setStaffRole, removeStaff, createSession, getSession, destroySession } from "./db.mjs";

// process.env đứng SAU (ghi đè) giá trị đọc từ file .env — cục bộ chỉ có file .env nên dùng file; trên
// Render (hay bất kỳ host nào khác) không có file .env thật (chỉ set biến qua dashboard, nạp thẳng vào
// process.env, không phải file), nên phải ưu tiên process.env thì mới đọc được đúng giá trị đã cấu hình.
const ENV_PATH = new URL("./.env", import.meta.url);
const readEnv = () => ({
  ...(fs.existsSync(ENV_PATH)
    ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
    : {}),
  ...process.env,
});
let _env = readEnv();

// Khoá bí mật cố định cho Custom Menu Link — vá lỗ hổng thật của Tầng 1: nếu chỉ tin ?email=, bất kỳ ai
// biết domain app + 1 email nhân viên có thể tự gõ thẳng URL để "đóng vai" người đó, không cần qua GHL
// chút nào. Có thêm khoá này thì phải biết CẢ 2 thứ cùng lúc, và khoá chỉ nằm trong URL đã lưu ở Custom
// Menu Link trên GHL (không hiện lại cho người xem thường) — nâng cao rào chắn thật, dù vẫn không mạnh
// bằng chữ ký mã hoá thật của Tầng 2 (Marketplace App SSO).
// Tự sinh 1 lần nếu chưa có (không bắt người dùng tự nghĩ chuỗi ngẫu nhiên), lưu vào .env — .env vốn đã
// gitignored, cùng chỗ với GHL_PIT. LƯU Ý khi deploy: giá trị này phải được set CỐ ĐỊNH qua biến môi trường
// trên host thật (không để tự sinh lại) — nếu không, mỗi lần redeploy sẽ ra 1 khoá MỚI, làm hỏng Custom
// Menu Link đã lưu trên GHL (đang trỏ khoá CŨ).
export function getCmlKey() {
  if (!_env.CML_KEY) {
    fs.appendFileSync(ENV_PATH, `\nCML_KEY=${crypto.randomBytes(16).toString("hex")}\n`);
    _env = readEnv();
  }
  return _env.CML_KEY;
}

// Tầng 2 — Marketplace App SSO thật (Custom Page trong 1 Private App, không phải Custom Menu Link nữa):
// GHL tự sinh 1 gói dữ liệu MÃ HOÁ MỚI mỗi lần trang được mở (qua postMessage giữa trang của mình và cửa
// sổ cha), gồm userId/email/role/activeLocation... — không bao giờ nằm cố định lộ ra trong URL/HTML như
// Tầng 1, nên không thể lấy 1 lần rồi dùng lại giả danh người khác. Giải mã bằng đúng thuật toán GHL công
// bố (AES, CryptoJS.AES.decrypt với Shared Secret làm passphrase — dùng thẳng thư viện crypto-js thay vì
// tự viết lại phần dẫn xuất khoá kiểu OpenSSL, tránh sai sót khó phát hiện).
// Shared Secret lấy từ Advanced Settings > Auth trên trang app của Marketplace Developer — KHÔNG tự sinh
// được như CML_KEY (phải khớp đúng giá trị GHL đã cấp), nên nếu thiếu thì báo lỗi rõ thay vì tự chế 1 khoá.
export function getSharedSecret() {
  if (!_env.GHL_SHARED_SECRET) throw new Error("Thiếu GHL_SHARED_SECRET trong .env — lấy từ Advanced Settings > Auth của Marketplace App");
  return _env.GHL_SHARED_SECRET;
}
export function decryptGhlUserData(encryptedData) {
  const decrypted = CryptoJS.AES.decrypt(encryptedData, getSharedSecret()).toString(CryptoJS.enc.Utf8);
  if (!decrypted) throw new Error("Giải mã thất bại — dữ liệu không hợp lệ hoặc sai Shared Secret");
  return JSON.parse(decrypted);
}
