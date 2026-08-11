-- Additive only — no columns, no constraints, no data change. Safe to apply
-- to a live database.

-- Supports VoiceService.endOtherActiveSessions: on voice join/reconnect, find
-- this user's ACTIVE voice sessions in every OTHER room so they can be ended
-- server-side. Without this index the lookup falls back to the (status) index
-- and scans every room's active session for a userId match.
CREATE INDEX "voice_sessions_userId_status_idx" ON "voice_sessions"("userId", "status");
