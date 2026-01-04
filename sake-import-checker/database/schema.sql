-- ============================================
-- Sake Import Checker - Database Schema
-- Supabase PostgreSQL with pgvector
-- ============================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- Main Table: sake_imports
-- ============================================
CREATE TABLE IF NOT EXISTS sake_imports (
  id BIGSERIAL PRIMARY KEY,
  
  -- Product Information
  reported_product_name TEXT NOT NULL,
  category TEXT,
  exporter TEXT,
  origin_country TEXT,
  raw_importer_name TEXT,
  
  -- Metrics
  value NUMERIC,
  volume NUMERIC,
  unit_price NUMERIC,
  
  -- Vector Embedding (Gemini text-embedding-004: 768 dimensions)
  -- Use halfvec to save storage (requires pgvector 0.7.0+)
  name_embedding halfvec(768),
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for vector similarity search
-- Use IVFFlat with halfvec_cosine_ops for memory efficiency
CREATE INDEX IF NOT EXISTS idx_sake_imports_embedding 
  ON sake_imports 
  USING ivfflat (name_embedding halfvec_cosine_ops)
  WITH (lists = 100);

-- Index for text search
CREATE INDEX IF NOT EXISTS idx_sake_imports_name 
  ON sake_imports 
  USING gin (to_tsvector('simple', reported_product_name));

-- Index for filtering
CREATE INDEX IF NOT EXISTS idx_sake_imports_exporter 
  ON sake_imports (exporter);

CREATE INDEX IF NOT EXISTS idx_sake_imports_category 
  ON sake_imports (category);

-- ============================================
-- Upload Progress Table
-- ============================================
CREATE TABLE IF NOT EXISTS upload_progress (
  session_id TEXT PRIMARY KEY,
  current_count INT DEFAULT 0,
  total_count INT DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending, processing, complete, error
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- Search Logs Table (for analytics)
-- ============================================
CREATE TABLE IF NOT EXISTS search_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  chat_id BIGINT,
  query_text TEXT,
  photo_file_id TEXT,
  extracted_info JSONB, -- Gemini Vision output
  matched_product_id BIGINT REFERENCES sake_imports(id),
  confidence_score FLOAT,
  response_time_ms INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for analytics
CREATE INDEX IF NOT EXISTS idx_search_logs_created 
  ON search_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_logs_user 
  ON search_logs (user_id);

-- ============================================
-- RPC Function: Vector Search
-- ============================================
CREATE OR REPLACE FUNCTION search_products(
  query_embedding vector(768),
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.5
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
  ORDER BY si.name_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================
-- RPC Function: Get Stats
-- ============================================
CREATE OR REPLACE FUNCTION get_stats()
RETURNS TABLE (
  total_products BIGINT,
  last_updated TIMESTAMP WITH TIME ZONE,
  top_exporters JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*)::BIGINT AS total_products,
    MAX(updated_at) AS last_updated,
    (
      SELECT jsonb_agg(row_to_json(t))
      FROM (
        SELECT exporter, COUNT(*) AS count
        FROM sake_imports
        GROUP BY exporter
        ORDER BY count DESC
        LIMIT 5
      ) t
    ) AS top_exporters
  FROM sake_imports;
END;
$$;

-- ============================================
-- Trigger: Auto-update updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_sake_imports_updated
  BEFORE UPDATE ON sake_imports
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_upload_progress_updated
  BEFORE UPDATE ON upload_progress
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
