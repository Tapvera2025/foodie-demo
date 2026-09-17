-- migrate:up
-- =============================================================================
-- SYNC WATERMARKS (offline-sync demo milestone)
-- =============================================================================
--
-- Two independent instances of this platform run: an always-online "cloud"
-- system and an "edge" box that is normally cut off from the internet and
-- gets a short connectivity window to sync through Ably.
--
-- Orders/order_items/payments/refunds sync edge -> cloud only (insert-only:
-- an order is immutable after creation, enforced by
-- assert_order_snapshots_immutable, so there is no conflict to resolve in
-- that direction). Catalog rows (food_court/court_table/vendor/menu/
-- menu_item) sync cloud -> edge only, one-way, so there is no echo risk
-- either. Neither direction needs per-row origin tracking as a result — this
-- table exists purely to remember how far each direction has gotten, so a
-- device that reconnects after hours offline knows what it still needs to
-- send or ask for, and an idle sync cycle with nothing new doesn't re-walk
-- the whole table.
--
-- One row per (device_id, domain, direction). `device_id` is the exporting OR
-- importing device's own SYNC_DEVICE_ID (cloud names each edge device it
-- talks to; an edge device names itself).
CREATE TABLE sync_watermark (
  device_id             TEXT NOT NULL,
  domain                TEXT NOT NULL CHECK (domain IN ('orders', 'catalog')),
  direction              TEXT NOT NULL CHECK (direction IN ('export', 'import')),
  -- Cursor state. Both orders and catalog use watermark_updated_at as an
  -- updated_at cursor — orders originally walked created_at only (status
  -- changes were out of scope for that milestone), but a status transition
  -- touches updated_at without changing created_at, so the cursor moved to
  -- updated_at once status sync was added (see export-orders.ts). watermark_row_id
  -- breaks ties when two rows share a timestamp.
  watermark_updated_at  TIMESTAMPTZ,
  watermark_row_id      UUID,
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_batch_row_count  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, domain, direction)
);

COMMENT ON TABLE sync_watermark IS
  'How far each side of the offline-sync pipeline has gotten, per device/domain/direction. Not an outbox — orders and catalog rows are read fresh from their own tables at export time, this just remembers the cursor.';

-- migrate:down
DROP TABLE IF EXISTS sync_watermark;
