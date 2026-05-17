-- Prevent two openings of the same color from sharing a name within one user's
-- library. Cross-color name collisions are allowed (e.g. "Sicilian" for white
-- and "Sicilian" for black are distinct repertoires).
--
-- If this migration fails on existing data, dedupe first by renaming or
-- deleting the conflicting rows.

alter table "public"."openings"
  add constraint "openings_user_color_name_key"
  unique (user_id, color, name);
