-- Games Phase 3 completion: matchmaking modes/teams/seats, private+password
-- lobbies, and staked-seat bots. All columns are additive with safe defaults, so
-- this migration is backward-compatible with existing rows.
--
-- NOTE: generated via `prisma migrate diff` (live DB → schema) because a
-- pre-existing broken migration blocks `migrate dev` shadow-replay in this env.
-- Apply with `prisma migrate deploy` once the migration history is repaired.

-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('CLASSIC', 'TEAM_2V2');

-- CreateEnum
CREATE TYPE "GameTeam" AS ENUM ('A', 'B');

-- AlterTable
ALTER TABLE "game_lobbies" ADD COLUMN     "isMatchmade" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mode" "GameMode" NOT NULL DEFAULT 'CLASSIC',
ADD COLUMN     "passwordHash" TEXT;

-- AlterTable
ALTER TABLE "game_lobby_members" ADD COLUMN     "botName" TEXT,
ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "team" "GameTeam";

-- AlterTable
ALTER TABLE "game_participants" ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seat" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "team" "GameTeam";

-- AlterTable
ALTER TABLE "game_sessions" ADD COLUMN     "mode" "GameMode" NOT NULL DEFAULT 'CLASSIC';
