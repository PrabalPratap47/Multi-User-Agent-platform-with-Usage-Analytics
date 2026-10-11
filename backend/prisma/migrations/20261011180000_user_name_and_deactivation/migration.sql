-- Admin user management: full name and soft deletion (deactivation).
-- Additive only: two nullable columns; existing accounts keep NULL (active, no name).
ALTER TABLE "users" ADD COLUMN "name" TEXT;
ALTER TABLE "users" ADD COLUMN "deactivatedAt" DATETIME;
