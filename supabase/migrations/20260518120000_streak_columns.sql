-- Phase 7: streak tracking on profiles.
-- current_streak: consecutive days the user has graded at least one review.
-- longest_streak: high-water mark of current_streak.
-- last_review_date: the most recent day a review was graded (local YYYY-MM-DD).
-- All three are updated by the client via bumpStreak() in shared/lib/streaks.

alter table "public"."profiles"
  add column if not exists "current_streak" integer not null default 0,
  add column if not exists "longest_streak" integer not null default 0,
  add column if not exists "last_review_date" date;
