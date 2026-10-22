// Đổi 1 token cấp CÔNG TY (agency) sang token riêng cho 1 sub-account cụ thể. GHL không trả locationId trong
// phản hồi OAuth khi người cài là user cấp agency — kể cả khi họ đã chọn đúng 1 sub-account lúc consent (xác
// nhận thật trên API, không phải giả định) — nên mọi kết nối cấp agency đều cần thêm bước đổi này mới dùng
// được cho đúng 1 location. Cùng tham khảo cách làm của "Uplifting Social AI" (123gym-media-mcp).
const BASE = "https://services.leadconnectorhq.com";

export async function mintLocationToken({ companyAccessToken, companyId, locationId, fetchImpl = globalThis.fetch }) {
  const r = await fetchImpl(`${BASE}/oauth/locationToken`, {
    method: "POST",
    headers: { Authorization: `Bearer ${companyAccessToken}`, Version: "2021-07-28", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ companyId, locationId }),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = {}; }
  if (!r.ok || !body.access_token) {
    // In thẳng nội dung lỗi của GHL vào thông báo trả về trình duyệt — log server (console.error) không đáng
    // tin cậy quanh lúc Render free-tier spin down/spin up (tiến trình có thể bị kill trước khi log kịp
    // flush), nên đặt luôn vào message để trang lỗi hiện ra là thấy ngay, không cần soi log.
    throw new Error(`Đổi token agency sang token sub-account thất bại (HTTP ${r.status}): ${text.slice(0, 300)}`);
  }
  // Token sub-account mint ra kiểu này KHÔNG có refresh_token riêng — hết hạn thì phải mint lại từ token công
  // ty (đã refresh nếu cần), không phải refresh trực tiếp bản thân nó.
  return { accessToken: body.access_token, expiresIn: Number(body.expires_in) || 86400 };
}
