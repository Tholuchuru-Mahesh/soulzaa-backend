-- AlterTable: track whether a RINGING call's invitation actually reached the callee's device
ALTER TABLE "calls" ADD COLUMN "deliveredAt" TIMESTAMP(3);
