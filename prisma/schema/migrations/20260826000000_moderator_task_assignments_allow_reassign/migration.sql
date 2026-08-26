-- A moderator may hold the same task DEFINITION more than once over time.
--
-- The unique (taskId, moderatorId) pair meant a definition could be assigned to
-- a given moderator exactly once, ever. Once that assignment completed, the
-- Official could never hand them the same piece of recurring work again — the
-- create screen just answered "Task is already assigned to this moderator".
-- Recurring duties ("Review 100 reports", "Ban User") are precisely the ones an
-- Official needs to re-issue.
--
-- Dropped rather than narrowed: the rule we actually want ("not twice while the
-- first one is still open") depends on `status`, which cannot be expressed as a
-- plain unique index, so it is enforced in ModeratorTaskAssignmentService.
-- The pair is still indexed, so that check stays a single index lookup.
DROP INDEX IF EXISTS "moderator_task_assignments_taskId_moderatorId_key";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "moderator_task_assignments_taskId_moderatorId_idx"
  ON "moderator_task_assignments"("taskId", "moderatorId");
