// Bộ điều phối module. Mỗi module phục vụ các đường dẫn dưới /apps/<key>/..., tự khai báo route của mình và
// KHÔNG đụng route của module khác (app gốc "center" vẫn ở gốc "/" như trước). Thêm module mới: tạo
// modules/<key>/index.mjs xuất { handle(ctx) } rồi đăng ký ở đây + khai báo app ở marketplace-apps.mjs.
//
// Lỗi trong 1 module được chặn tại đây — không làm sập request của module khác. (Sập cả tiến trình thì không
// chặn được ở tầng này; vì vậy mọi handler nền phải tự .catch.)
import zalo from "./zalo/index.mjs";
import service from "./service/index.mjs";

const MODULES = { zalo, service };

export async function dispatchModule(ctx) {
  const m = ctx.u.pathname.match(/^\/apps\/([a-z0-9-]+)(\/.*)?$/);
  if (!m || !MODULES[m[1]]) return false;
  ctx.sub = m[2] || "/";
  try {
    if (await MODULES[m[1]].handle(ctx)) return true;
  } catch (e) {
    console.error(`[module:${m[1]}] lỗi:`, e);
    if (!ctx.res.headersSent) ctx.json(ctx.res, { error: "Lỗi nội bộ của module " + m[1] }, 500);
    return true;
  }
  ctx.json(ctx.res, { error: "Không có đường dẫn này" }, 404);
  return true;
}
