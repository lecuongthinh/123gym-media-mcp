ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS default_user_id text;

-- HighLevel's Social Planner "create post" endpoint rejects every status,
-- including draft, when userId is absent (verified against the live API).
-- default_user_id lets the MCP fill it in automatically so ChatGPT/agents
-- never need to know a HighLevel-internal user id.
UPDATE connections
   SET default_user_id = 'Zeu2eFpcBJRg48IbaxWP'
 WHERE tenant_id = '00000000-0000-4000-8000-000000000124'
   AND provider = 'highlevel';
