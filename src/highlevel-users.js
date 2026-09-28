const LC_BASE_URL = "https://services.leadconnectorhq.com";

export async function fetchHighLevelUsers({ accessToken, locationId, fetchImpl = globalThis.fetch, baseUrl = LC_BASE_URL }) {
  const params = new URLSearchParams({ locationId });
  const response = await fetchImpl(`${baseUrl}/users/?${params}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Version: "2021-07-28", Accept: "application/json" }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(`LeadConnector Users API failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  const users = data.users || data.data?.users || [];
  return users.map((user) => ({
    id: user.id || user._id || null,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.name || null,
    email: user.email || null,
    role: user.roles?.role || user.role || null,
    type: user.roles?.type || null,
    isDefaultUserIdCandidate: /admin|owner/i.test(String(user.roles?.role || user.role || ""))
  }));
}

export function pickDefaultUserId(users) {
  if (!Array.isArray(users) || users.length === 0) return null;
  const preferred = users.find((user) => user.isDefaultUserIdCandidate && user.id);
  if (preferred) return preferred.id;
  return users.find((user) => user.id)?.id || null;
}

export async function fetchHighLevelLocationName({ accessToken, locationId, fetchImpl = globalThis.fetch, baseUrl = LC_BASE_URL }) {
  const response = await fetchImpl(`${baseUrl}/locations/${encodeURIComponent(locationId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Version: "2021-07-28", Accept: "application/json" }
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  const name = data.location?.name || data.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
