-- HighLevel issues a Company-scoped OAuth grant (no locationId in the token
-- response) whenever the authorizing HighLevel user is an agency-level user,
-- even when they picked one specific sub-account during consent -- verified
-- against the real API 2026-09-28. To bind the connection to the one
-- location a tenant actually wants, connect_highlevel now must be called
-- with an explicit locationId, recorded here before the redirect so the
-- callback can mint a location-scoped token via /oauth/locationToken.
ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS intended_location_id text;
