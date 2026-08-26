-- migrate:up
--
-- Separate "what may this user do" from "what kind of thing did this".
--
-- `user_role_assignment.role` was typed `actor_type`, which conflates two
-- different ideas that happened to share some spellings:
--
--   actor_type      WHO performed an action, for the audit trail. Includes
--                   SYSTEM, PROVIDER_WEBHOOK and POS_WEBHOOK — none of which
--                   are people and none of which can be assigned to a user.
--   platform_role   WHAT a user is permitted to do. This is what the RBAC
--                   matrix in src/identity/permissions.ts is written against.
--
-- The two vocabularies had already drifted. `actor_type` has a single
-- VENDOR_USER; the permission matrix distinguishes VENDOR_OPERATOR (works the
-- queue) from VENDOR_OWNER (also sees the money), and that distinction is the
-- entire reason a cook cannot read the stall's settlement report. It also has
-- COURT_OPERATOR and DEVICE, which `actor_type` lacks entirely.
--
-- Storing a role in an actor_type column meant those roles could not be
-- assigned at all, so the finer-grained half of the permission matrix was
-- unreachable. TypeScript caught it the moment the login endpoint tried to put
-- a database role into a token claim.
--
-- Cheap now, expensive later: there is no production data, and the alternative
-- was a mapping function at the boundary that would have quietly preserved the
-- confusion.

CREATE TYPE platform_role AS ENUM (
  'CUSTOMER',
  'DEVICE',
  'VENDOR_OPERATOR',
  'VENDOR_OWNER',
  'MANAGER',
  'COURT_OPERATOR',
  'PLATFORM_OPS',
  'PLATFORM_FINANCE',
  'SUPER_ADMIN'
);

-- The CHECK constraint has to go first.
--
-- `role_scope_valid` compares `role` against literals that Postgres bound to
-- `actor_type` when the table was created. Changing the column type leaves the
-- constraint's own expression comparing platform_role to actor_type, and the
-- ALTER fails with "operator does not exist: platform_role = actor_type" —
-- which reads like a problem with the data and is actually a problem with a
-- constraint nobody mentioned.
ALTER TABLE user_role_assignment DROP CONSTRAINT role_scope_valid;

-- VENDOR_USER is the only value that needs translating; it becomes the
-- narrower of the two vendor roles, because defaulting staff to the one that
-- can see settlement would be the wrong way to be wrong.
ALTER TABLE user_role_assignment
  ALTER COLUMN role TYPE platform_role
  USING (
    CASE role::text
      WHEN 'VENDOR_USER' THEN 'VENDOR_OPERATOR'
      WHEN 'SYSTEM'            THEN 'PLATFORM_OPS'
      WHEN 'PROVIDER_WEBHOOK'  THEN 'PLATFORM_OPS'
      WHEN 'POS_WEBHOOK'       THEN 'PLATFORM_OPS'
      ELSE role::text
    END
  )::platform_role;

-- Recreated against the new vocabulary. The rule is unchanged in spirit: a role
-- must be scoped to exactly the thing it governs, so a stall login cannot exist
-- without a stall and a platform role cannot be pinned to one.
ALTER TABLE user_role_assignment ADD CONSTRAINT role_scope_valid CHECK (
  (role = 'SUPER_ADMIN'  AND food_court_id IS NULL AND vendor_id IS NULL) OR
  (role IN ('PLATFORM_OPS','PLATFORM_FINANCE') AND vendor_id IS NULL)     OR
  -- MANAGER runs one court; COURT_OPERATOR is the operator's own staff. Same
  -- shape, different employer, and the permission matrix separates them.
  (role IN ('MANAGER','COURT_OPERATOR') AND food_court_id IS NOT NULL AND vendor_id IS NULL) OR
  -- Both vendor roles require a stall. VENDOR_OWNER additionally sees
  -- settlement, which is a permission question rather than a scoping one.
  (role IN ('VENDOR_OPERATOR','VENDOR_OWNER') AND vendor_id IS NOT NULL)  OR
  -- A device is issued to a stall, or to the court for a shared display board.
  (role = 'DEVICE' AND (vendor_id IS NOT NULL OR food_court_id IS NOT NULL)) OR
  -- A customer holds no staff scope at all. Present for completeness; customer
  -- sessions do not use this table.
  (role = 'CUSTOMER' AND food_court_id IS NULL AND vendor_id IS NULL)
);

COMMENT ON COLUMN user_role_assignment.role IS
  'Authorisation role, matching src/identity/permissions.ts ROLES. Not actor_type — that records who did something, this records what they may do.';

-- migrate:down
SELECT 'not implemented' AS note;
