import assert from "node:assert/strict";
import test from "node:test";

import { fetchHighLevelUsers, pickDefaultUserId } from "./src/highlevel-users.js";

test("pickDefaultUserId prefers an admin/owner role", () => {
  const users = [
    { id: "user-1", role: "user", isDefaultUserIdCandidate: false },
    { id: "user-2", role: "admin", isDefaultUserIdCandidate: true }
  ];
  assert.equal(pickDefaultUserId(users), "user-2");
});

test("pickDefaultUserId falls back to the first user when nobody is admin/owner", () => {
  const users = [
    { id: "user-1", role: "user", isDefaultUserIdCandidate: false },
    { id: "user-2", role: "user", isDefaultUserIdCandidate: false }
  ];
  assert.equal(pickDefaultUserId(users), "user-1");
});

test("pickDefaultUserId returns null for an empty or missing list", () => {
  assert.equal(pickDefaultUserId([]), null);
  assert.equal(pickDefaultUserId(undefined), null);
});

test("fetchHighLevelUsers maps HighLevel's user shape and binds locationId/token", async () => {
  const fetchImpl = async (url, options) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/users/");
    assert.equal(parsed.searchParams.get("locationId"), "loc-1");
    assert.equal(options.headers.Authorization, "Bearer token-1");
    return new Response(JSON.stringify({ users: [
      { id: "user-1", firstName: "A", lastName: "B", email: "a@example.com", roles: { role: "owner", type: "account" } }
    ] }), { status: 200 });
  };
  const users = await fetchHighLevelUsers({ accessToken: "token-1", locationId: "loc-1", fetchImpl });
  assert.deepEqual(users, [{ id: "user-1", name: "A B", email: "a@example.com", role: "owner", type: "account", isDefaultUserIdCandidate: true }]);
});

test("fetchHighLevelUsers throws on a non-2xx response instead of returning an empty list silently", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: "The token is not authorized for this scope." }), { status: 401 });
  await assert.rejects(() => fetchHighLevelUsers({ accessToken: "token-1", locationId: "loc-1", fetchImpl }), /401/);
});
