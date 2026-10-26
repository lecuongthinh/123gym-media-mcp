// Lược đồ dữ liệu của module "Project & Service Management" (ELUX = khách đầu tiên). Khoá object/field ở đây
// KHỚP với snapshot GHL (elux-ghl-build/spec.mjs). Tên chung (Site/Asset/Work order...) để ngành khác dùng lại:
// chỉ đổi nhãn + danh sách lựa chọn, không đổi cấu trúc.
export const OBJ = {
  site: "custom_objects.cong_trinh",
  unit: "custom_objects.thang_may",
  contract: "custom_objects.hop_dong",
  project: "custom_objects.du_an",
  order: "custom_objects.phieu_dich_vu",
  inspection: "custom_objects.kiem_dinh",
};

// Lựa chọn (key lưu vào GHL → nhãn hiển thị). Server chỉ nhận key nằm trong danh sách này.
export const OPTIONS = {
  orderType: [["bao_tri_dinh_ky", "Bảo trì định kỳ"], ["su_co", "Sự cố"], ["sua_chua", "Sửa chữa"], ["bao_hanh", "Bảo hành"]],
  orderPriority: [["khan_cap", "Khẩn cấp"], ["cao", "Cao"], ["binh_thuong", "Bình thường"], ["thap", "Thấp"]],
  orderStatus: [["moi", "Mới"], ["da_giao", "Đã giao việc"], ["dang_xu_ly", "Đang xử lý"], ["cho_vat_tu", "Chờ vật tư"], ["hoan_thanh", "Hoàn thành"], ["huy", "Hủy"]],
  orderSource: [["ung_dung", "Nhân viên nhập"], ["qr", "Quét QR"], ["dien_thoai", "Điện thoại"], ["dinh_ky", "Tự sinh định kỳ"]],
  siteType: [["chung_cu", "Chung cư"], ["van_phong", "Văn phòng"], ["khach_san", "Khách sạn"], ["benh_vien", "Bệnh viện"], ["nha_may", "Nhà máy"], ["trung_tam_thuong_mai", "Trung tâm thương mại"], ["nha_o", "Nhà ở"], ["khac", "Khác"]],
  unitType: [["hanh_khach", "Hành khách"], ["hang", "Chở hàng"], ["gia_dinh", "Gia đình"], ["thang_cuon", "Thang cuốn"], ["khac", "Khác"]],
  unitStatus: [["chua_ban_giao", "Chưa bàn giao"], ["dang_bao_hanh", "Đang bảo hành"], ["dang_bao_tri", "Đang bảo trì"], ["het_hop_dong", "Hết hợp đồng"], ["ngung_hoat_dong", "Ngừng hoạt động"]],
  contractType: [["mua_ban_lap_dat", "Mua bán - lắp đặt"], ["bao_tri", "Bảo trì"], ["cai_tao", "Cải tạo"], ["sua_chua", "Sửa chữa"]],
  contractScope: [["full", "Bảo trì toàn diện"], ["kiem_tra_boi_tron", "Kiểm tra và bôi trơn"]],
  contractStatus: [["du_thao", "Dự thảo"], ["hieu_luc", "Hiệu lực"], ["het_han", "Hết hạn"], ["huy", "Hủy"]],
  projectStage: [["ky_hd", "Ký hợp đồng"], ["tam_ung", "Tạm ứng"], ["dat_hang", "Đặt hàng/nhập khẩu"], ["giao_hang", "Giao về công trình"], ["lap_dat", "Lắp đặt"], ["chay_thu", "Chạy thử/tự kiểm tra"], ["kiem_dinh", "Kiểm định"], ["nghiem_thu", "Nghiệm thu bàn giao"], ["bao_hanh", "Bảo hành"], ["hoan_tat", "Hoàn tất"]],
  inspectionStatus: [["len_lich", "Lên lịch"], ["da_nop_ho_so", "Đã nộp hồ sơ"], ["da_kiem_dinh", "Đã kiểm định"], ["hoan_tat", "Hoàn tất"]],
  inspectionResult: [["dat", "Đạt"], ["dat_co_dieu_kien", "Đạt có điều kiện"], ["khong_dat", "Không đạt"]],
};
export const keysOf = (name) => OPTIONS[name].map(([k]) => k);
export const isOption = (name, v) => keysOf(name).includes(v);

// Trạng thái "đã xong" của từng loại — dùng để loại khỏi các cảnh báo.
export const ORDER_CLOSED = ["hoan_thanh", "huy"];
export const INSPECTION_OPEN = ["len_lich", "da_nop_ho_so"];

// Ngưỡng cảnh báo (ngày) — chỉnh được theo từng khách sau này (hiện là mặc định chung).
export const THRESHOLDS = { inspectionDays: 60, contractDays: 90, warrantyDays: 60 };
