CREATE TABLE IF NOT EXISTS relay_frames (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  from_device TEXT NOT NULL,
  to_device TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_frames_target_cursor ON relay_frames(to_device, seq);
CREATE INDEX IF NOT EXISTS relay_frames_expiry ON relay_frames(expires_at);
