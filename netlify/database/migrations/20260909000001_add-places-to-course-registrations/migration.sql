-- A registration can now reserve more than one place (a group booking).
--
-- Seat availability therefore becomes the SUM of `places` across seat-holding
-- registrations instead of a plain row count. Existing rows hold one place.

ALTER TABLE course_registrations
  ADD COLUMN places INTEGER NOT NULL DEFAULT 1 CHECK (places > 0);
