// Permission "packs": the unit an Uplifting admin switches on or off for a
// customer. A pack bundles read-only tools with the HighLevel scopes they
// need. Pack ids and tool names are a public contract (customers' skills call
// the tools by name, and ChatGPT caches the tool schema): add new ones, never
// rename.

export const ROLES = ["owner", "admin", "manager", "staff", "viewer"];

export const PACKS = Object.freeze({
  contacts: {
    label: "Khách hàng (Contacts)",
    scopes: ["contacts.readonly"],
    tools: ["crm_search_contacts", "crm_contact_summary"]
  },
  opportunities: {
    label: "Pipeline / cơ hội",
    scopes: ["opportunities.readonly"],
    tools: ["crm_list_pipelines", "crm_search_opportunities", "crm_pipeline_summary"]
  },
  conversations: {
    label: "Hội thoại",
    scopes: ["conversations.readonly", "conversations/message.readonly"],
    tools: ["crm_search_conversations"]
  },
  calendar: {
    label: "Lịch hẹn",
    scopes: ["calendars.readonly", "calendars/events.readonly"],
    tools: ["crm_list_calendars", "crm_list_appointments"]
  },
  payments: {
    label: "Thanh toán / doanh thu",
    scopes: ["payments/orders.readonly", "payments/transactions.readonly"],
    tools: ["crm_list_orders", "crm_revenue_summary"]
  },
  custom_objects: {
    label: "Custom Objects",
    scopes: ["objects/schema.readonly", "objects/record.readonly"],
    tools: ["crm_list_object_schemas", "crm_search_object_records"]
  },
  social_planner: {
    label: "Social Planner",
    scopes: [
      "socialplanner/account.readonly", "socialplanner/post.readonly", "socialplanner/statistics.readonly",
      "socialplanner/category.readonly", "socialplanner/tag.readonly"
    ],
    tools: ["crm_list_social_accounts", "crm_list_social_posts", "crm_social_statistics"]
  }
});

export const PACK_IDS = Object.freeze(Object.keys(PACKS));

// Scopes every install needs regardless of packs (location name, staff list).
export const BASE_SCOPES = Object.freeze(["locations.readonly", "users.readonly"]);

// The whole scope list the Marketplace app must declare (read-only only).
export function allRequestedScopes() {
  return [...new Set([...BASE_SCOPES, ...PACK_IDS.flatMap((id) => PACKS[id].scopes)])];
}

// Tools that need no pack: they only describe the caller's own access.
export const ALWAYS_ALLOWED_TOOLS = Object.freeze(["get_my_permissions"]);

const TOOL_TO_PACK = new Map(PACK_IDS.flatMap((id) => PACKS[id].tools.map((tool) => [tool, id])));

export function packForTool(toolName) {
  return TOOL_TO_PACK.get(toolName) || null;
}

// Built-in role ceilings, used for any (tenant, role, pack) with no row in
// report_role_packs. Admin edits override these per customer.
export const DEFAULT_ROLE_PACKS = Object.freeze({
  owner: PACK_IDS,
  admin: PACK_IDS,
  manager: PACK_IDS.filter((id) => id !== "payments"),
  staff: ["contacts", "opportunities", "conversations", "calendar"],
  viewer: ["opportunities", "calendar", "social_planner"]
});

// One-click presets for approving a new customer in the dashboard.
export const PRESETS = Object.freeze({
  none: { label: "Không bật gì", packs: [] },
  basic: { label: "Cơ bản (khách hàng, pipeline, lịch hẹn)", packs: ["contacts", "opportunities", "calendar"] },
  social: { label: "Chỉ Social Planner", packs: ["social_planner"] },
  full: { label: "Tất cả gói chỉ đọc", packs: PACK_IDS }
});

export function defaultRoleAllows(role, pack) {
  return (DEFAULT_ROLE_PACKS[role] || []).includes(pack);
}

// permissions: { grants: { [pack]: boolean }, rolePacks: { "role:pack": boolean } }
export function roleAllows(permissions, role, pack) {
  const stored = permissions?.rolePacks?.[`${role}:${pack}`];
  return typeof stored === "boolean" ? stored : defaultRoleAllows(role, pack);
}

// Pure decision used by both the tool gate and get_my_permissions, so what a
// person is told they can do is exactly what the gate enforces.
export function effectivePacks({ tenantStatus, role, permissions }) {
  if (tenantStatus !== "active") return [];
  return PACK_IDS.filter((pack) => permissions?.grants?.[pack] === true && roleAllows(permissions, role, pack));
}

export function explainDenial({ tenantStatus, role, permissions, pack }) {
  if (tenantStatus === "pending") return "Tài khoản đang chờ Uplifting duyệt quyền. Chưa có gói dữ liệu nào được bật.";
  if (tenantStatus !== "active") return "Tài khoản đang bị tạm khóa. Liên hệ Uplifting.";
  if (permissions?.grants?.[pack] !== true) return `Gói "${PACKS[pack]?.label || pack}" chưa được bật cho tài khoản này. Nhờ Uplifting bật trong trang quản lý quyền.`;
  return `Vai trò "${role}" chưa được dùng gói "${PACKS[pack]?.label || pack}" ở tài khoản này.`;
}
