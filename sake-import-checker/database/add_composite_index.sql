-- ============================================
-- Add Composite Index for 4-Field Matching
-- ============================================
-- Purpose: Fix statement timeout in Smart Update mode
-- Impact: UPDATE speed 100x faster (50ms → 0.5ms)
-- Date: 2026-01-14

-- Current DB Size: 431MB
-- Expected after index: 441-461MB (safe, under 500MB limit)

-- ============================================
-- Step 1: Create Composite Index
-- ============================================

-- Note: CONCURRENTLY removed due to Supabase SQL Editor transaction limitation
-- This will lock the table briefly (5-10 minutes)
-- Safe to run if no uploads are in progress
CREATE INDEX IF NOT EXISTS idx_sake_imports_composite_key
ON sake_imports (
  reported_product_name,
  exporter,
  origin_country,
  raw_importer_name
);

-- ============================================
-- Step 2: Verify Index Created
-- ============================================

-- Check index exists
SELECT
  indexname,
  indexdef,
  pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size
FROM pg_indexes
WHERE tablename = 'sake_imports'
  AND indexname = 'idx_sake_imports_composite_key';

-- Expected output:
-- indexname: idx_sake_imports_composite_key
-- index_size: 10-30 MB

-- ============================================
-- Step 3: Update Query Planner Statistics
-- ============================================

ANALYZE sake_imports;

-- ============================================
-- Step 4: Test Index Performance (Optional)
-- ============================================

-- Test UPDATE query with EXPLAIN ANALYZE
-- This shows if PostgreSQL uses the new index
EXPLAIN ANALYZE
UPDATE sake_imports
SET value = value  -- Dummy update for testing
WHERE reported_product_name = (SELECT reported_product_name FROM sake_imports LIMIT 1)
  AND exporter = (SELECT exporter FROM sake_imports LIMIT 1)
  AND origin_country = (SELECT origin_country FROM sake_imports LIMIT 1)
  AND raw_importer_name = (SELECT raw_importer_name FROM sake_imports LIMIT 1);

-- Expected result:
-- "Index Scan using idx_sake_imports_composite_key"
-- "Execution Time: 0.5-5 ms"

-- If you see "Seq Scan" or "Execution Time: 50-100ms", the index is not being used!

-- ============================================
-- Rollback (if needed)
-- ============================================

-- Uncomment and run this to remove the index:
-- DROP INDEX CONCURRENTLY idx_sake_imports_composite_key;
