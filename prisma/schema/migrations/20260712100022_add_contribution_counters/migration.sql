-- CreateTable
CREATE TABLE "room_contribution_counters" (
    "roomId" UUID NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_contribution_counters_pkey" PRIMARY KEY ("roomId")
);

-- CreateTable
CREATE TABLE "user_contribution_counters" (
    "userId" UUID NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_contribution_counters_pkey" PRIMARY KEY ("userId")
);
