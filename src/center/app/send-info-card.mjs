// Gửi thẻ "chia sẻ số điện thoại" cho 1 khách Zalo của 1 trung tâm.
// Dùng: node send-info-card.mjs <locationId> <zaloUid>
import { sendRequestInfoCard } from "./zalo-oa.mjs";
const [loc, uid] = process.argv.slice(2);
if (!loc || !uid) { console.error("Dùng: node send-info-card.mjs <locationId> <zaloUid>"); process.exit(1); }
try { await sendRequestInfoCard(loc, uid); console.log("Đã gửi thẻ."); }
catch (e) { console.error("Lỗi:", e.message, e.zaloErrorCode ?? ""); process.exit(2); }
process.exit(0);
