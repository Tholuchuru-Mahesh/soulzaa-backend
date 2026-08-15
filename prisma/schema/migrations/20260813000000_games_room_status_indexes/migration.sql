-- Audio Room <-> Games integration: composite indexes backing the
-- "does this room have an active session / open lobby" lookup
-- (GamesRepository.findActiveSessionForRoom, lobby roomId filter).
-- Additive only, no data change.

-- CreateIndex
CREATE INDEX "game_lobbies_roomId_status_idx" ON "game_lobbies"("roomId", "status");

-- CreateIndex
CREATE INDEX "game_sessions_roomId_status_idx" ON "game_sessions"("roomId", "status");
