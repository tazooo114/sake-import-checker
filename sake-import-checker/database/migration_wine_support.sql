-- ============================================
-- Wine Support Migration
-- Adds multi-category support (Wine, Sake, Spirits, etc.)
-- ============================================

-- ============================================
-- 1. Add Category Validation Constraint
-- ============================================
ALTER TABLE sake_imports
DROP CONSTRAINT IF EXISTS check_category;

ALTER TABLE sake_imports
ADD CONSTRAINT check_category
CHECK (category IN ('Sake', 'Wine', 'Spirits', 'Etc-Wine', 'Etc-Sake', 'Etc-Spirits', 'Other') OR category IS NULL);

-- ============================================
-- 2. Update search_products() RPC Function
-- Add category_filter parameter with sub-category support
-- ============================================
CREATE OR REPLACE FUNCTION search_products(
  query_embedding vector(768),
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.5,
  category_filter TEXT DEFAULT NULL  -- NEW: optional category filter
)
RETURNS TABLE (
  id BIGINT,
  reported_product_name TEXT,
  category TEXT,
  exporter TEXT,
  origin_country TEXT,
  raw_importer_name TEXT,
  value NUMERIC,
  volume NUMERIC,
  unit_price NUMERIC,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    si.id,
    si.reported_product_name,
    si.category,
    si.exporter,
    si.origin_country,
    si.raw_importer_name,
    si.value,
    si.volume,
    si.unit_price,
    1 - (si.name_embedding <=> query_embedding) AS similarity
  FROM sake_imports si
  WHERE 1 - (si.name_embedding <=> query_embedding) > similarity_threshold
    AND (
      category_filter IS NULL
      OR si.category = category_filter
      -- Wine search: Wine + Etc-Wine only
      OR (category_filter = 'Wine' AND si.category = 'Etc-Wine')
      -- Sake search: everything EXCEPT Wine/Etc-Wine
      -- (일본 사케/소주/기타주류 등은 모두 Sake 검색 대상에 포함)
      OR (category_filter = 'Sake' AND si.category NOT IN ('Wine', 'Etc-Wine'))
      -- Spirits search: Spirits + Etc-Spirits
      OR (category_filter = 'Spirits' AND si.category = 'Etc-Spirits')
    )
  ORDER BY si.name_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================
-- 3. Update get_stats() RPC Function
-- Add detailed category breakdown
-- ============================================
CREATE OR REPLACE FUNCTION get_stats()
RETURNS TABLE (
  total_products BIGINT,
  sake_count BIGINT,
  wine_count BIGINT,
  spirits_count BIGINT,
  etc_wine_count BIGINT,
  etc_sake_count BIGINT,
  etc_spirits_count BIGINT,
  other_count BIGINT,
  last_updated TIMESTAMP WITH TIME ZONE,
  top_exporters JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE category = 'Sake')::BIGINT,
    COUNT(*) FILTER (WHERE category = 'Wine')::BIGINT,
    COUNT(*) FILTER (WHERE category = 'Spirits')::BIGINT,
    COUNT(*) FILTER (WHERE category = 'Etc-Wine')::BIGINT,
    COUNT(*) FILTER (WHERE category = 'Etc-Sake')::BIGINT,
    COUNT(*) FILTER (WHERE category = 'Etc-Spirits')::BIGINT,
    COUNT(*) FILTER (WHERE category = 'Other')::BIGINT,
    MAX(updated_at),
    (
      SELECT jsonb_agg(row_to_json(t))
      FROM (
        SELECT category, exporter, COUNT(*) AS count
        FROM sake_imports
        GROUP BY category, exporter
        ORDER BY count DESC
        LIMIT 20
      ) t
    ) AS top_exporters
  FROM sake_imports;
END;
$$;

-- ============================================
-- Migration Complete
-- ============================================
-- This migration:
-- 1. Adds category constraint supporting Wine, Sake, Spirits, and sub-categories
-- 2. Updates search_products() to support category filtering
-- 3. Updates get_stats() to show detailed category breakdown
--
-- No new columns added - uses existing schema!
-- Wine metadata (region, grape, vintage) extracted from product names during search
