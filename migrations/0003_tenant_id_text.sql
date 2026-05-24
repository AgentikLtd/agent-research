-- Fix: tenant_id was declared UUID in 0001 + 0002, but tenants carry
-- Clerk org IDs (TEXT, e.g. `org_3Dm9w429DcZ2cD3J5KQ2Y6NZyY4`). Forward-only
-- ALTER. Both tables are empty on the only deployed tenant (demo1505) so
-- no data conversion needed.
--
-- The source migrations 0001_episodic.sql + 0002_semantic.sql have ALSO
-- been edited in-place to declare TEXT from the start, so this migration
-- is a no-op for new tenants (the ALTER TYPE TEXT → TEXT is harmless).

ALTER TABLE agent_research_episodic.entries
  ALTER COLUMN tenant_id TYPE TEXT USING tenant_id::TEXT;

ALTER TABLE agent_research_semantic.facts
  ALTER COLUMN tenant_id TYPE TEXT USING tenant_id::TEXT;
