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
  task: "custom_objects.cong_viec",
};

// Người liên quan của từng loại bản ghi: [khoá association, nhãn vai trò, kind]. kind = "contact" (người) | "business" (công ty).
// Vai trò nằm ở NHÃN liên kết theo từng bản ghi (cùng một người có thể là Kế toán ở hợp đồng này, Tư vấn ở công trình kia).
export const PEOPLE_ROLES = {
  cong_trinh: [["cong_trinh_chu_dau_tu", "Chủ đầu tư", "business"], ["cong_trinh_ban_quan_ly", "Ban quản lý", "business"], ["cong_trinh_chu_so_huu", "Chủ sở hữu", "business"], ["cong_trinh_lien_he_chinh", "Liên hệ chính", "contact"], ["cong_trinh_tu_van_thiet_ke", "Tư vấn thiết kế", "contact"], ["cong_trinh_tong_thau", "Tổng thầu", "contact"], ["cong_trinh_ky_su", "Kỹ sư công trình", "contact"], ["cong_trinh_ke_toan", "Kế toán", "contact"]],
  hop_dong: [["hop_dong_khach_hang", "Khách hàng ký", "business"], ["hop_dong_nguoi_ky", "Người ký", "contact"], ["hop_dong_ke_toan", "Kế toán", "contact"]],
  thang_may: [["thang_may_lien_he_van_hanh", "Liên hệ vận hành", "contact"]],
  phieu: [["phieu_nguoi_bao", "Người báo", "contact"]],
  du_an: [["du_an_chu_dau_tu", "Chủ đầu tư", "business"], ["du_an_tong_thau", "Tổng thầu", "contact"], ["du_an_giam_sat", "Tư vấn giám sát", "contact"], ["du_an_lien_he", "Liên hệ dự án", "contact"]],
  kiem_dinh: [["kiem_dinh_don_vi", "Đơn vị kiểm định", "business"], ["kiem_dinh_lien_he", "Liên hệ tại công trình", "contact"]],
};
export const PEOPLE_OBJ = { cong_trinh: OBJ.site, hop_dong: OBJ.contract, thang_may: OBJ.unit, phieu: OBJ.order, du_an: OBJ.project, kiem_dinh: OBJ.inspection };
export const PEOPLE_KEYS = new Set(Object.values(PEOPLE_ROLES).flat().map((r) => r[0]));

// Lựa chọn (key lưu vào GHL → nhãn hiển thị). Server chỉ nhận key nằm trong danh sách này.
export const OPTIONS = {
  orderType: [["bao_tri_dinh_ky", "Bảo trì định kỳ"], ["su_co", "Sự cố"], ["sua_chua", "Sửa chữa"], ["bao_hanh", "Bảo hành"]],
  orderPriority: [["khan_cap", "Khẩn cấp"], ["cao", "Cao"], ["binh_thuong", "Bình thường"], ["thap", "Thấp"]],
  orderStatus: [["moi", "Mới"], ["da_giao", "Đã giao việc"], ["dang_xu_ly", "Đang xử lý"], ["cho_vat_tu", "Chờ vật tư"], ["hoan_thanh", "Hoàn thành"], ["huy", "Hủy"]],
  orderSource: [["ung_dung", "Nhân viên nhập"], ["qr", "Quét QR"], ["dien_thoai", "Điện thoại"], ["dinh_ky", "Tự sinh định kỳ"]],
  siteType: [["chung_cu", "Chung cư"], ["van_phong", "Văn phòng"], ["khach_san", "Khách sạn"], ["benh_vien", "Bệnh viện"], ["nha_may", "Nhà máy"], ["trung_tam_thuong_mai", "Trung tâm thương mại"], ["nha_o", "Nhà ở"], ["khac", "Khác"]],
  unitType: [["hanh_khach", "Hành khách"], ["hang", "Chở hàng"], ["gia_dinh", "Gia đình"], ["thang_cuon", "Thang cuốn"], ["khac", "Khác"]],
  unitStatus: [["chua_ban_giao", "Chưa bàn giao"], ["dang_bao_hanh", "Đang bảo hành"], ["dang_bao_tri", "Đang bảo trì"], ["ngoai_bao_hanh", "Ngoài bảo hành"], ["ngung_hoat_dong", "Ngừng hoạt động"]],
  contractType: [["mua_ban_lap_dat", "Mua bán - lắp đặt"], ["bao_tri", "Bảo trì"], ["cai_tao", "Cải tạo"], ["sua_chua", "Sửa chữa"]],
  contractScope: [["full", "Bảo trì toàn diện"], ["kiem_tra_boi_tron", "Kiểm tra và bôi trơn"]],
  contractStatus: [["du_thao", "Dự thảo"], ["hieu_luc", "Hiệu lực"], ["het_han", "Hết hạn"], ["huy", "Hủy"]],
  projectStage: [["ky_hd", "Ký hợp đồng"], ["tam_ung", "Tạm ứng"], ["dat_hang", "Đặt hàng/nhập khẩu"], ["giao_hang", "Giao về công trình"], ["lap_dat", "Lắp đặt"], ["chay_thu", "Chạy thử/tự kiểm tra"], ["kiem_dinh", "Kiểm định"], ["nghiem_thu", "Nghiệm thu bàn giao"], ["bao_hanh", "Bảo hành"], ["hoan_tat", "Hoàn tất"]],
  inspectionStatus: [["len_lich", "Lên lịch"], ["da_nop_ho_so", "Đã nộp hồ sơ"], ["da_kiem_dinh", "Đã kiểm định"], ["hoan_tat", "Hoàn tất"]],
  // Vòng đời dự án (cấp dự án, nhỏ và dùng chung mọi ngành). Giai đoạn cũ của thang máy (projectStage) vẫn đọc được nhờ ánh xạ ở logic.mjs.
  projectLifecycle: [["chuan_bi", "Chuẩn bị"], ["dang_thuc_hien", "Đang thực hiện"], ["bao_hanh", "Bảo hành"], ["hoan_tat", "Hoàn tất"]],
  taskStatus: [["chua_lam", "Chưa làm"], ["dang_lam", "Đang làm"], ["cho_kiem_tra", "Chờ kiểm tra"], ["hoan_thanh", "Hoàn thành"], ["huy", "Hủy"]],
  taskType: [["viec", "Công việc"], ["moc", "Mốc"]],
  inspectionResult: [["dat", "Đạt"], ["dat_co_dieu_kien", "Đạt có điều kiện"], ["khong_dat", "Không đạt"]],
};
export const keysOf = (name) => OPTIONS[name].map(([k]) => k);
export const isOption = (name, v) => keysOf(name).includes(v);

// Trạng thái "đã xong" của từng loại — dùng để loại khỏi các cảnh báo.
export const ORDER_CLOSED = ["hoan_thanh", "huy"];
export const INSPECTION_OPEN = ["len_lich", "da_nop_ho_so"];

// Ngưỡng cảnh báo (ngày) — chỉnh được theo từng khách sau này (hiện là mặc định chung).
export const THRESHOLDS = { inspectionDays: 60, contractDays: 90, warrantyDays: 60 };
