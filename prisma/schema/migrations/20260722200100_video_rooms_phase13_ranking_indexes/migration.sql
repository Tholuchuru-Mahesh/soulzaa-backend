-- VR-13: indexes the ranking recompute path needs. Additive only — no columns,
-- no constraints, no data change. Safe to apply to a live database.

-- Global (non-room-scoped) video-room recompute: WHERE contextType = 'VIDEO_ROOM'
-- AND createdAt >= $1 AND createdAt < $2. The existing
-- (contextType, contextId, createdAt) index cannot serve this, because
-- contextId is unbound.
CREATE INDEX "gift_transactions_contextType_createdAt_idx" ON "gift_transactions"("contextType", "createdAt");

-- Treasure-dimension recompute selects winners by time window.
CREATE INDEX "treasure_winners_selectedAt_idx" ON "treasure_winners"("selectedAt");
