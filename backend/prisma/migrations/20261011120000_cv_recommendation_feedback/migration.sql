-- CV Classification Agent feedback (2-4 sentences) on each recommendation.
-- Additive only: one nullable column; existing rows keep NULL (no feedback).
ALTER TABLE "cv_recommendations" ADD COLUMN "feedback" TEXT;
