-- Extend active unpaid course holds to the twenty-minute reservation window.

UPDATE course_registrations
SET status = 'EXPIRED',
    hold_expires_at = NULL,
    updated_at = NOW()
WHERE status = 'PENDING'
  AND updated_at + INTERVAL '20 minutes' <= NOW();

UPDATE course_registrations
SET hold_expires_at = GREATEST(
      hold_expires_at,
      updated_at + INTERVAL '20 minutes'
    )
WHERE status = 'PENDING'
  AND hold_expires_at IS NOT NULL;
