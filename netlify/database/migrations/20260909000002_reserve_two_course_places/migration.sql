-- Keep places unavailable for confirmed attendees who are not represented by
-- an active website registration.

ALTER TABLE course_cohorts
  ADD COLUMN places_reserved INTEGER NOT NULL DEFAULT 0
  CHECK (places_reserved >= 0 AND places_reserved <= seats_total);

UPDATE course_cohorts
SET places_reserved = 2
WHERE slug = 'ai-data-foundations-2026-10';
