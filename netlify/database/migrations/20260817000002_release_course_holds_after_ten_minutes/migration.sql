-- Shorten existing unpaid course holds to the ten-minute reservation window.

UPDATE course_registrations
SET status = 'EXPIRED',
    hold_expires_at = NULL,
    updated_at = NOW()
WHERE status = 'PENDING'
  AND updated_at + INTERVAL '10 minutes' <= NOW();

UPDATE course_registrations
SET hold_expires_at = LEAST(
      hold_expires_at,
      updated_at + INTERVAL '10 minutes'
    )
WHERE status = 'PENDING'
  AND hold_expires_at IS NOT NULL;
