// Danh sách các app Marketplace mà service này phục vụ. Mỗi app = 1 client_id/secret riêng trên GHL, 1 link
// cài riêng, 1 Custom Page riêng — khách cài app nào dùng app đó, không bị kéo theo app khác. Tất cả cùng chạy
// trong 1 service Render (xem ZALO_OA_SETUP.md, mục "Mô hình module").
//
// Thêm app mới: khai báo 1 mục ở đây + 1 module trong modules/ (xem modules/index.mjs).
import fs from "fs";

const ENV_PATH = new URL("./.env", import.meta.url);
const env = {
  ...(fs.existsSync(ENV_PATH)
    ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
    : {}),
  ...process.env,
};
// CENTER_-prefixed ưu tiên trước — xem ghi chú tương tự trong oauth-onboarding.mjs.
if (env.CENTER_HIGHLEVEL_CLIENT_ID) env.HIGHLEVEL_CLIENT_ID = env.CENTER_HIGHLEVEL_CLIENT_ID;
if (env.CENTER_HIGHLEVEL_CLIENT_SECRET) env.HIGHLEVEL_CLIENT_SECRET = env.CENTER_HIGHLEVEL_CLIENT_SECRET;
const BASE_URL = env.PUBLIC_BASE_URL || "https://center-management-rvii.onrender.com";

const APPS = {
  // App gốc (quản lý trung tâm). Giữ nguyên tên biến môi trường cũ để không phải đổi cấu hình đang chạy.
  center: {
    key: "center",
    clientId: env.HIGHLEVEL_CLIENT_ID, clientSecret: env.HIGHLEVEL_CLIENT_SECRET,
  },
  // App kết nối Zalo OA. Quyền: đọc/ghi hội thoại + tạo contact + trường tuỳ chỉnh "Zalo UID".
  zalo: {
    key: "zalo",
    clientId: env.ZALO_CONNECTOR_CLIENT_ID, clientSecret: env.ZALO_CONNECTOR_CLIENT_SECRET,
    sharedSecret: env.ZALO_CONNECTOR_SHARED_SECRET, // Advanced Settings > Auth của app — giải mã SSO Custom Page
    versionId: env.ZALO_CONNECTOR_VERSION_ID,       // đổi mỗi lần phát hành phiên bản mới của app
    redirectUri: `${BASE_URL}/apps/zalo/oauth/callback`,
    scopes: "conversations.readonly conversations.write conversations/message.readonly conversations/message.write contacts.readonly contacts.write locations.readonly locations/customFields.readonly locations/customFields.write",
  },
};

export const getApp = (key) => {
  const a = APPS[key];
  if (!a) throw new Error(`App Marketplace không tồn tại: ${key}`);
  return a;
};
export const appConfigured = (key) => { const a = APPS[key]; return Boolean(a?.clientId && a?.clientSecret); };
export const publicBaseUrl = () => BASE_URL;
