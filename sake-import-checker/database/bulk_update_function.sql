-- ============================================
-- Bulk Update Function for Sake Imports
-- ============================================
-- Purpose: Fix statement timeout by processing multiple UPDATEs in a single RPC call
-- Impact: Network round-trips reduced from 100 to 1
-- Date: 2026-01-14

-- ============================================
-- Step 1: Create Bulk Update Function
-- ============================================

CREATE OR REPLACE FUNCTION bulk_update_sake_imports(updates JSONB)
RETURNS INTEGER AS $$
DECLARE
  update_count INTEGER;
BEGIN
  -- Single UPDATE statement using FROM clause with JSONB data
  -- IS NOT DISTINCT FROM handles NULL comparisons correctly
  WITH update_data AS (
    SELECT
      (item->>'name')::text AS name,
      (item->>'exporter')::text AS exporter,
      (item->>'origin')::text AS origin,
      (item->>'importer')::text AS importer,
      (item->>'category')::text AS category,
      (item->>'value')::numeric AS value,
      (item->>'volume')::numeric AS volume,
      (item->>'unit_price')::numeric AS unit_price
    FROM jsonb_array_elements(updates) AS item
  )
  UPDATE sake_imports t
  SET
    category = u.category,
    value = u.value,
    volume = u.volume,
    unit_price = u.unit_price
  FROM update_data u
  WHERE t.reported_product_name = u.name
    AND t.exporter IS NOT DISTINCT FROM u.exporter
    AND t.origin_country IS NOT DISTINCT FROM u.origin
    AND t.raw_importer_name IS NOT DISTINCT FROM u.importer;

  GET DIAGNOSTICS update_count = ROW_COUNT;
  RETURN update_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Step 2: Grant Execute Permission
-- ============================================

-- Grant execute permission to authenticated and anon users
GRANT EXECUTE ON FUNCTION bulk_update_sake_imports(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION bulk_update_sake_imports(JSONB) TO anon;
GRANT EXECUTE ON FUNCTION bulk_update_sake_imports(JSONB) TO service_role;

-- ============================================
-- Step 3: Verify Function Created
-- ============================================

-- Check function exists
SELECT
  proname AS function_name,
  pg_get_function_arguments(oid) AS arguments,
  pg_get_function_result(oid) AS return_type
FROM pg_proc
WHERE proname = 'bulk_update_sake_imports';

-- ============================================
-- Test Query (Optional)
-- ============================================

-- Test with sample data:
-- SELECT bulk_update_sake_imports('[
--   {"name": "테스트 제품", "exporter": "Exporter1", "origin": "JP", "importer": "Importer1", "category": "Sake", "value": 1000, "volume": 50, "unit_price": 20}
-- ]'::jsonb);
