# Center Management module

Quản lý lớp học/giáo viên/điểm danh cho các trung tâm giáo dục (Candy English, EIM Lê Hồng Phong...) —
**không liên quan gì** tới khách hàng của Uplifting Social AI. Vendor nguyên con từ repo gốc
[`center-management`](https://github.com/lecuongthinh/center-management) vào `src/center/app/` (code) và
`src/center/frontend/` (React, build ra `src/center/app/dist/`) để dùng chung 1 Render service trả phí thay
vì trả thêm $7/tháng cho 1 service riêng — xem lý do đầy đủ trong lịch sử trao đổi, tóm tắt: rủi ro chính là
2 nhóm khách hàng hoàn toàn khác nhau dùng chung 1 tiến trình, chấp nhận được vì tần suất lỗi thấp (~1
lần/tuần, ~8 giây/lần theo log thật lúc quyết định).

Giống hệt khuôn `src/report/`: tự chứa, route riêng (`/center/*`), DB riêng (project Supabase riêng, KHÔNG
dùng chung `DATABASE_URL` của app này), có công tắc tắt hẳn (`CENTER_ENABLED`), có lớp bắt lỗi riêng để lỗi
của module này không làm sập cả tiến trình.

## Vì sao `app/server.mjs` không thay đổi (gần như) gì

File gốc `requestHandler` tự định tuyến theo `req.url` (vd `/api/candy/me`) — không biết gì về tiền tố
`/center`. Mount bằng `app.use('/center', ...)` của Express tự động CẮT tiền tố khỏi `req.url` trước khi gọi
handler, nên code gốc chạy đúng không cần sửa gì về routing.

**Thứ tự gắn vào `server.js` RẤT quan trọng:** phải gắn `/center` TRƯỚC `app.use(express.json(...))` của app
chủ. Center Management tự đọc body thô (`for await (const ch of req) body += ch`), không dùng `req.body` —
nếu `express.json()` chạy trước, nó sẽ đọc hết stream, code center-management nhận body rỗng, mọi
POST/PUT (đăng nhập, điểm danh, ghi danh...) sẽ hỏng âm thầm. Đã kiểm chứng thật: xem test lúc tích hợp —
không có 1 route POST nào bị sai thứ tự.

## Biến môi trường trùng tên — PHẢI dùng tiền tố `CENTER_`

App này (Uplifting Social AI) và Center Management vốn độc lập, nên có chỗ dùng TRÙNG TÊN biến:
`DATABASE_URL`, `HIGHLEVEL_CLIENT_ID`, `HIGHLEVEL_CLIENT_SECRET`, `HIGHLEVEL_REDIRECT_URI`,
`TENANT_CREDENTIAL_ENCRYPTION_KEY`. Code trong `src/center/app/` đã sửa để ưu tiên đọc biến có tiền tố
`CENTER_` trước (vd `CENTER_DATABASE_URL`), chỉ fallback về tên trần nếu thiếu — nên **PHẢI luôn set đủ các
biến `CENTER_*` dưới đây trên Render của app này**, không được để trống (nếu để trống, module sẽ vô tình đọc
nhầm sang database/app GHL của Uplifting Social AI).

| Biến trên Render (app này) | Giá trị lấy từ |
|---|---|
| `CENTER_ENABLED` | `true` để bật module |
| `CENTER_DATABASE_URL` | `DATABASE_URL` hiện tại của service `center-management` (project Supabase riêng — KHÔNG đổi, chỉ copy sang đây) |
| `CENTER_HIGHLEVEL_CLIENT_ID`, `CENTER_HIGHLEVEL_CLIENT_SECRET` | `HIGHLEVEL_CLIENT_ID`/`SECRET` hiện tại của service `center-management` (app Marketplace "Center management" trên GHL) |
| `CENTER_HIGHLEVEL_REDIRECT_URI` | **Đổi thành** `https://<domain mới>/center/oauth/callback` — domain đổi nên redirect URI phải đổi theo, và phải cập nhật lại trên GHL Marketplace App "Center management" (Advanced Settings > Auth) |
| `CENTER_TENANT_CREDENTIAL_ENCRYPTION_KEY` | `TENANT_CREDENTIAL_ENCRYPTION_KEY` hiện tại của service `center-management` (nếu đổi khoá, mọi credential OAuth đã lưu của các tenant sẽ giải mã hỏng — PHẢI copy nguyên giá trị cũ, không tạo khoá mới) |
| `CML_KEY`, `GHL_SHARED_SECRET` | Copy y nguyên từ service `center-management` (không trùng tên với app này, không cần đổi) |

Các biến còn lại của center-management (`ZALO_*`, `GHL_API_BASE`, `GHL_PRIVATE_TOKEN`, `GHL_LOCATION_ID`,
`PUBLIC_BASE_URL`, `MIRROR_DELAY_MS`...) không trùng tên, copy y nguyên tên+giá trị từ service cũ là đủ.
`PUBLIC_BASE_URL` nên set thành `https://<domain mới>/center`.

## Việc còn lại để LÊN THẬT (chưa làm — cần xác nhận trước khi đổi vì ảnh hưởng service đang chạy)

1. Trên Render của service `uplifting-social-ai`: set toàn bộ biến môi trường ở bảng trên + copy các biến
   còn lại của center-management, đổi Build Command thành `npm install && npm run build` (hiện chưa có bước
   build frontend nào).
2. Trên GHL Marketplace App "Center management": đổi Redirect URL (Advanced Settings > Auth) sang
   `https://<domain mới>/center/oauth/callback`, publish version mới.
3. Merge nhánh `feat/center-management-module` vào `main` (auto-deploy).
4. Test thật: đăng nhập Candy English + EIM qua domain MỚI, xác nhận điểm danh/ghi danh vẫn ghi đúng vào GHL.
5. Sau khi xác nhận ổn định: suspend/xoá service `center-management` riêng trên Render (tiết kiệm $7/tháng) —
   chỉ làm SAU khi bước 4 đã test kỹ, không làm song song.
