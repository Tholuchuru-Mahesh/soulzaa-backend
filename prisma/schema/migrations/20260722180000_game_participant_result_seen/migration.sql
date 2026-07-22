-- Resume-on-launch: tracks whether a participant has acknowledged their
-- match's result screen, so a completed session isn't auto-resurfaced by
-- `GET games/me/active-match` forever. Additive, nullable — safe on existing
-- rows (NULL == "not yet acknowledged").

-- AlterTable
ALTER TABLE "game_participants" ADD COLUMN     "resultSeenAt" TIMESTAMP(3);
