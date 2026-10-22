// Center Management — module "quản lý lớp học/giáo viên/điểm danh" cho các trung tâm KHÔNG liên quan tới
// khách hàng của Uplifting Social AI (vd Candy English, EIM). Tự chứa trong src/center/ (không đụng gì tới
// code đăng bài/report phía trên), dùng chung tiến trình + Render service để khỏi trả thêm $7/tháng cho 1
// service riêng — xem ghi chú đầy đủ trong README.md mục "Center Management module".
//
// Tắt hẳn (kill switch) bằng CENTER_ENABLED khác "true": mọi đường /center/* trả 404, không nạp code bên
// trong (app/server.mjs) — tránh crash lúc khởi động nếu thiếu cấu hình khi tạm thời tắt module này.
export function centerEnabled(env = process.env) {
  return env.CENTER_ENABLED === "true";
}

export async function createCenterRouter({ env = process.env } = {}) {
  if (!centerEnabled(env)) {
    return (req, res) => { res.status(404).json({ error: "not_found" }); };
  }
  // Nạp chậm (lazy import) — app/server.mjs đọc biến môi trường NGAY lúc nạp module (ví dụ kiểm tra
  // DATABASE_URL), nên chỉ nạp khi module này THẬT SỰ bật, tránh crash cả service nếu module tắt mà thiếu
  // cấu hình riêng của nó.
  const { requestHandler } = await import("./app/server.mjs");
  return async (req, res) => {
    try {
      await requestHandler(req, res);
    } catch (e) {
      // Lớp bảo vệ THỨ HAI — app/server.mjs tự bắt lỗi nội bộ của nó rồi (xem ghi chú ERR_HTTP_HEADERS_SENT
      // trong app/server.mjs), nhưng thêm 1 lớp ở đây để lỗi của module này KHÔNG BAO GIỜ làm sập cả tiến
      // trình chung (ảnh hưởng tới khách hàng hoàn toàn khác của Uplifting Social AI).
      console.error("[center] unhandled", e);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    }
  };
}
