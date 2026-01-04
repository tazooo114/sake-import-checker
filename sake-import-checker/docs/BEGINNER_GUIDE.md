# 왕초보 설치 가이드 (Beginner's Guide)

이 가이드는 개발 지식이 전혀 없는 분들도 따라 할 수 있도록 작성되었습니다.

## 1. 텔레그램 봇 만들기

1. 텔레그램에서 **@BotFather**를 검색해서 대화를 시작하세요.
2. `/newbot` 이라고 입력하세요.
3. 봇의 이름(예: `My Sake Bot`)을 입력하세요.
4. 봇의 아이디(예: `my_sake_checker_bot`)를 입력하세요. (반드시 `bot`으로 끝나야 합니다)
5. 화면에 나오는 **HTTP API Token**을 복사해서 메모장에 저장해두세요. (이게 `TELEGRAM_BOT_TOKEN` 입니다)

## 2. 구글 AI 키 받기

1. [Google AI Studio](https://aistudio.google.com/app/apikey)에 접속하세요.
2. **Get API key** 버튼을 누르세요.
3. **Create API key in new project**를 선택하세요.
4. 생성된 키를 복사해서 저장해두세요. (이게 `GEMINI_API_KEY` 입니다)

## 3. 데이터베이스 만들기 (Supabase)

1. [Supabase](https://supabase.com/)에 회원가입하고 **New Project**를 만드세요.
2. Database Password를 설정하고 잘 기억해두세요.
3. 프로젝트가 생성되면 왼쪽 메뉴에서 **Settings (톱니바퀴) > API**로 가세요.
4. **Project URL**과 **anon / public** 키를 복사해서 저장해두세요. (`SUPABASE_URL`, `SUPABASE_KEY`)
5. 왼쪽 메뉴에서 **SQL Editor**로 이동하세요.
6. 아래 코드를 복사해서 붙여넣고 **Run** 버튼을 누르세요.

```sql
-- pgvector 확장 기능 켜기
CREATE EXTENSION IF NOT EXISTS vector;

-- 사케 데이터 테이블 만들기
CREATE TABLE sake_imports (
  id BIGSERIAL PRIMARY KEY,
  reported_product_name TEXT NOT NULL,
  category TEXT,
  exporter TEXT,
  origin_country TEXT,
  raw_importer_name TEXT,
  value NUMERIC,
  volume NUMERIC,
  unit_price NUMERIC,
  name_embedding vector(768),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 검색 성능 높이기 (HNSW 인덱스)
CREATE INDEX idx_sake_imports_embedding 
  ON sake_imports 
  USING hnsw (name_embedding vector_cosine_ops) 
  WITH (m = 24, ef_construction = 128);

-- 검색 함수 만들기
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

-- 업로드 진행률 테이블
CREATE TABLE upload_progress (
  session_id TEXT PRIMARY KEY,
  current_count INT DEFAULT 0,
  total_count INT DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 통계 함수
CREATE OR REPLACE FUNCTION get_stats()
RETURNS TABLE (
  total_products BIGINT,
  last_updated TIMESTAMP
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    (SELECT COUNT(*) FROM sake_imports) as total_products,
    (SELECT MAX(created_at) FROM sake_imports) as last_updated;
END;
$$;
```

## 4. 관리자 페이지 사용법

배포가 완료되면 관리자 페이지 주소(예: `https://sake-admin.pages.dev`)로 접속하세요.

1. **로그인**: 설정한 비밀번호 입력
2. **업로드 모드 선택**:
   - **스마트 업데이트 (권장)**: 기존 데이터는 유지하고, 변경된 내용만 업데이트합니다. (빠르고 안전함)
   - **전체 초기화 (주의)**: 모든 데이터를 지우고 처음부터 다시 올립니다. 데이터가 꼬였을 때만 사용하세요.
3. **엑셀 파일 선택**: 드래그하거나 클릭해서 업로드
   - **필수 컬럼**: `Product Name (KR)`
   - **권장 컬럼**: `Product Name (EN)`, `Exporter`, `Volume`, `Value` 등
4. **기다리기**: 진행률 바가 100%가 될 때까지 기다리세요. (50개씩 나눠서 올라갑니다)

## 5. 문제 해결

- **업로드가 멈췄어요**: 새로고침 후 "스마트 업데이트" 모드로 다시 올리세요. 이전에 성공한 건 건너뛰고 이어서 합니다.
- **검색이 안 돼요**: 사진이 흔들렸거나, 아직 데이터가 업로드되지 않았을 수 있습니다.
- **오류 메시지**: "일시적인 오류"는 구글 서버 문제일 수 있으니 1분 뒤에 다시 시도해보세요.
