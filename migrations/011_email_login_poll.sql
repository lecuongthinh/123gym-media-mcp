-- Lets the original ChatGPT sign-in window finish an email login by itself.
-- The emailed link may be opened in a different tab/browser/device than the
-- window ChatGPT is waiting on, and ChatGPT's callback only works in that
-- original window ("thiếu dữ liệu OAuth callback" otherwise). The original
-- window holds a secret poll token; when the link is clicked, the finished
-- redirect is parked here until the poll collects it exactly once.
ALTER TABLE email_login_tokens ADD COLUMN IF NOT EXISTS poll_hash text UNIQUE;
ALTER TABLE email_login_tokens ADD COLUMN IF NOT EXISTS completed_redirect text;
