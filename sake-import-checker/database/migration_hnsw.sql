-- ============================================
-- HNSW 인덱스 마이그레이션 스크립트
-- IVFFlat → HNSW 전환 (검색 정확도 향상)
-- ============================================
-- 
-- 사용 방법:
-- 1. Supabase 대시보드 → SQL Editor 접속
-- 2. 이 파일 내용 전체를 복사하여 붙여넣기
-- 3. Run 버튼 클릭
--
-- 예상 소요 시간: 데이터 2,500개 기준 약 1-2분
-- ============================================

-- Step 1: 기존 IVFFlat 인덱스 삭제
DROP INDEX IF EXISTS idx_sake_imports_embedding;

-- Step 2: HNSW 인덱스 생성을 위한 메모리 할당
-- (Supabase 무료 티어에서도 작동하는 안전한 값)
SET maintenance_work_mem = '256MB';

-- Step 3: HNSW 인덱스 생성
-- m=24: 각 노드당 연결 수 (높을수록 정확하지만 메모리 사용 증가)
-- ef_construction=128: 인덱스 구축 시 탐색 깊이 (높을수록 정확)
CREATE INDEX idx_sake_imports_embedding 
  ON sake_imports 
  USING hnsw (name_embedding vector_cosine_ops) 
  WITH (m = 24, ef_construction = 128);

-- Step 4: 검색 함수 업데이트 (HNSW 최적화)
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
  -- HNSW 검색 시 탐색 깊이 설정 (높을수록 정확하지만 느림)
  SET LOCAL hnsw.ef_search = 100;
  
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
-- 완료! 아래 쿼리로 인덱스 상태를 확인하세요:
-- ============================================
-- SELECT indexname, indexdef 
-- FROM pg_indexes 
-- WHERE tablename = 'sake_imports';
