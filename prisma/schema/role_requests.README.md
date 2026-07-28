-- Enforces one OPEN request per (subjectUserId, type). Terminal statuses are
-- excluded so a user may reapply after a decision. Apply with the migration
-- that creates role_requests.
CREATE UNIQUE INDEX role_requests_one_open_per_subject_type
  ON role_requests ("subjectUserId", type)
  WHERE status IN ('SUBMITTED', 'IN_REVIEW', 'NEEDS_INFO');
