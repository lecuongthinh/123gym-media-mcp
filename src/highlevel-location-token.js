const LC_BASE_URL = "https://services.leadconnectorhq.com";

// Mints a location-scoped access token from a Company-level (agency) OAuth
// grant. HighLevel does not return a locationId in the initial token
// response when the authorizing user is an agency-level user -- confirmed
// against the real API 2026-09-28 -- so every Company-scoped connection
// needs this extra exchange to get a token actually usable against a single
// sub-account's endpoints. The minted token has no refresh_token of its own;
// it is re-minted from the company access token whenever it expires.
export async function mintLocationToken({ companyAccessToken, companyId, locationId, fetchImpl = globalThis.fetch, baseUrl = LC_BASE_URL }) {
  const response = await fetchImpl(`${baseUrl}/oauth/locationToken`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${companyAccessToken}`,
      Version: "2021-07-28",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ companyId, locationId })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!response.ok || !body.access_token) {
    const error = new Error(`Location token exchange failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return { accessToken: body.access_token, expiresIn: Number(body.expires_in) || 86400 };
}
