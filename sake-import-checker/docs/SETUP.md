# 설치 가이드 (Setup Guide)

## 사전 요구사항

- Node.js 18 이상
- npm 또는 yarn
- Cloudflare 계정
- Supabase 계정
- Google AI Studio 계정 (Gemini API)
- Telegram 계정

---

## 1. Supabase 설정

### 1.1 프로젝트 생성
1. [Supabase](https://supabase.com) 접속
2. New Project 클릭
3. 프로젝트 이름 입력 (예: `sake-import-checker`)
4. 데이터베이스 비밀번호 설정 (저장해두기)
5. Region: `Northeast Asia (Seoul)` 선택

### 1.2 HNSW 인덱스 및 스키마 설정
1. SQL Editor 접속
2. 다음 SQL을 실행하여 테이블과 최적화된 인덱스를 생성합니다:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sake_imports (
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 검색 정확도 향상을 위한 HNSW 인덱스 설정
SET maintenance_work_mem = '256MB';
CREATE INDEX IF NOT EXISTS idx_sake_imports_embedding 
  ON sake_imports 
  USING hnsw (name_embedding vector_cosine_ops) 
  WITH (m = 24, ef_construction = 128);

CREATE INDEX IF NOT EXISTS idx_sake_imports_name 
  ON sake_imports 
  USING gin (to_tsvector('simple', reported_product_name));

CREATE TABLE IF NOT EXISTS upload_progress (
  session_id TEXT PRIMARY KEY,
  current_count INT DEFAULT 0,
  total_count INT DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS search_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  chat_id BIGINT,
  query_text TEXT,
  photo_file_id TEXT,
  extracted_info JSONB,
  matched_product_id BIGINT,
  confidence_score FLOAT,
  response_time_ms INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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
  -- HNSW 검색 최적화
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
```

### 1.3 Wine Support 마이그레이션 (2026-01-12 이후)

**⚠️ 기존 설치 시 필수 실행**

와인 라벨 인식 기능을 활성화하려면 Supabase SQL Editor에서 다음 마이그레이션을 실행하세요:

```sql
-- 카테고리 제약 조건 추가 (7가지 카테고리 지원)
ALTER TABLE sake_imports
DROP CONSTRAINT IF EXISTS check_category;

ALTER TABLE sake_imports
ADD CONSTRAINT check_category
CHECK (category IN ('Sake', 'Wine', 'Spirits', 'Etc-Wine', 'Etc-Sake', 'Etc-Spirits', 'Other') OR category IS NULL);

-- search_products() RPC 함수 업데이트 (카테고리 필터링 추가)
CREATE OR REPLACE FUNCTION search_products(
  query_embedding vector(768),
  match_count INT DEFAULT 10,
  similarity_threshold FLOAT DEFAULT 0.5,
  category_filter TEXT DEFAULT NULL
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
    AND (
      category_filter IS NULL
      OR si.category = category_filter
      OR (category_filter = 'Wine' AND si.category = 'Etc-Wine')
      OR (category_filter = 'Sake' AND si.category = 'Etc-Sake')
      OR (category_filter = 'Spirits' AND si.category = 'Etc-Spirits')
    )
  ORDER BY si.name_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- get_stats() RPC 함수 업데이트 (카테고리별 통계)
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
    (SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT category, exporter, COUNT(*) AS count
      FROM sake_imports
      GROUP BY category, exporter
      ORDER BY count DESC
      LIMIT 20
    ) t)
  FROM sake_imports;
END;
$$;
```

**참고**: 전체 마이그레이션 파일은 `database/migration_wine_support.sql` 참조

### 1.4 API 정보 확인
1. Settings > API 이동
2. 다음 정보 저장:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: `eyJhbGc...`

---

## 2. Gemini API 설정

### 2.1 API 키 발급
1. [Google AI Studio](https://aistudio.google.com) 접속
2. Get API Key 클릭
3. Create API Key 클릭
4. 키 복사 및 저장

---

## 3. Telegram Bot 생성

### 3.1 Bot 생성
1. Telegram에서 `@BotFather` 검색
2. `/newbot` 명령어 입력
3. 봇 이름 입력 (예: `Sake Search Bot`)
4. 봇 username 입력 (예: `sake_search_bot`)
5. 토큰 복사 및 저장

---

## 4. Cloudflare Workers 배포

### 4.1 프로젝트 설정
```bash
cd sake-import-checker/backend
npm install
```

### 4.2 Secrets 설정
```bash
wrangler secret put TELEGRAM_BOT_TOKEN
# 토큰 입력

wrangler secret put GEMINI_API_KEY
# API 키 입력

wrangler secret put SUPABASE_URL
# https://xxxxx.supabase.co 입력

wrangler secret put SUPABASE_KEY
# anon public key 입력

wrangler secret put ADMIN_PASSWORD
# 관리자 비밀번호 설정

wrangler secret put TELEGRAM_WEBHOOK_SECRET
# 웹훅 발신자 검증용 임의 문자열 (아래 5장에서 같은 값을 다시 씁니다)
# 생성 예: openssl rand -hex 32
# 허용 문자: A-Z a-z 0-9 _ -  (1~256자)
```

> `TELEGRAM_WEBHOOK_SECRET`은 **5장에서 `setWebhook`에 넘길 값과 반드시 같아야**
> 합니다. 값을 지금 만들어 어딘가에 적어두세요.

### 4.3 배포
```bash
wrangler deploy
```

배포 후 URL 확인 (예: `https://sake-import-checker.your-subdomain.workers.dev`)

---

## 5. Telegram Webhook 설정

`secret_token`에는 **4.2에서 `TELEGRAM_WEBHOOK_SECRET`으로 넣은 값과 똑같은
문자열**을 넘겨야 합니다.

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -d "url=https://sake-import-checker.your-subdomain.workers.dev/telegram-webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET과 동일한 값>"
```

성공 응답:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### 5.1 secret_token은 왜 필요한가

웹훅 URL은 인증이 없는 공개 엔드포인트입니다. 주소를 알아낸 제3자가 가짜 update
JSON을 POST하면, 봇이 임의의 `chat_id`로 메시지를 보내거나 Gemini 할당량을
소진하게 만들 수 있습니다.

`secret_token`을 등록하면 Telegram이 매 요청에
`X-Telegram-Bot-Api-Secret-Token` 헤더를 실어 보내고, Worker가 이를 대조해
일치하지 않는 요청을 무시합니다 (`handlers/telegram.ts`의 `isFromTelegram`).

### 5.2 값을 바꾸거나 잊었을 때

두 값이 어긋나면 봇이 **모든 메시지에 무응답**이 됩니다(에러 없이 조용히 무시).
이때는 양쪽을 새 값으로 다시 맞추면 됩니다.

```bash
# 1) Worker 쪽 갱신
wrangler secret put TELEGRAM_WEBHOOK_SECRET

# 2) Telegram 쪽 갱신 (같은 값)
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -d "url=https://sake-import-checker.your-subdomain.workers.dev/telegram-webhook" \
  -d "secret_token=<새 값>"
```

현재 등록 상태는 `getWebhookInfo`로 확인할 수 있습니다. 다만 응답에
`secret_token` 값 자체는 표시되지 않고, 설정 여부만 알 수 있습니다.

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"
```

> **기존 봇을 운영 중이라면**: `TELEGRAM_WEBHOOK_SECRET`을 설정하지 않은 상태에서는
> Worker가 검증을 건너뛰고 기존처럼 동작합니다(로그에 경고만 남습니다). 따라서
> 배포 순서 때문에 봇이 멈추는 일은 없습니다. 다만 **secret을 넣은 뒤에는 반드시
> `setWebhook`도 다시 호출**해야 합니다. Worker에만 넣고 Telegram 쪽을 갱신하지
> 않으면 그때부터 모든 요청이 차단됩니다.

---

## 6. Admin 페이지 배포 (Cloudflare Pages)

### 6.1 배포
```bash
cd sake-import-checker/admin
wrangler pages deploy . --project-name=sake-admin
```

### 6.2 API 연결 및 CORS
`admin/js/upload.js`의 `API_BASE` 수정:
```javascript
const API_BASE = 'https://sake-import-checker.your-subdomain.workers.dev';
```

**주의**: CORS 정책상 `backend/src/index.ts`에 `https://sake-admin.pages.dev`가 허용되어 있어야 합니다. (기본 설정되어 있음)

---

## 7. 테스트

### 7.1 Health Check
```bash
curl https://sake-import-checker.your-subdomain.workers.dev/health
```

### 7.2 Telegram Bot 테스트 (사케 - 기본 기능)
1. 생성한 봇에게 `/start` 메시지 전송
2. 사케 라벨 사진 전송
3. 응답 확인:
   - 브랜드명, 제조사, 수입사 표시
   - 확신도(confidence) 표시
   - **기대 응답**: `제조사/수출사:` 라벨

### 7.3 Telegram Bot 테스트 (와인 - Wine Support v1.0)
1. 와인 병 라벨 사진 전송
2. 응답 확인:
   - 와이너리(생산자) 추출 및 표시
   - 생산 지역 정보 추출
   - 포도품종 정보 추출
   - 빈티지(연도) 정보 추출
   - **기대 응답**: `와이너리:` 라벨 (제조사/수출사 아님)
3. 카테고리 필터링 확인:
   - 와인 검색 → 와인만 반환 (사케 결과 없음)
   - 사케 검색 → 사케만 반환 (와인 결과 없음)

### 7.4 Admin 엑셀 업로드 테스트 (혼합 데이터)
1. 다음 구성으로 테스트 엑셀 생성:
   - 행 1-3: 와인 (Category: 과실주)
   - 행 4-6: 사케 (Category: 청주)
   - 행 7-9: 기타주류 + HS-CODE (2204: Etc-Wine, 2206: Etc-Sake)

2. Admin 페이지에서 업로드
3. 확인사항:
   - ✅ 카테고리 자동 분류 (Category + HS-CODE 기반)
   - ✅ 모든 제품이 검색 대상에 포함됨
   - ✅ 임베딩 텍스트에 Origin Country 포함

---

## 트러블슈팅

### Webhook 오류
```bash
# Webhook 정보 확인
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### 로그 확인
```bash
wrangler tail
```

### 데이터베이스 인덱스 확인
HNSW 인덱스가 정상적으로 생성되었는지 확인하려면 Supabase SQL Editor에서 다음을 실행하세요:
```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'sake_imports';
```
`USING hnsw`가 보이면 정상입니다.

---

## 버전 정보

### Wine Support v1.0 (2026-01-12)
✅ **기능**: 와인 라벨 인식 및 수입 상태 확인
- 자동 제품 타입 감지 (사케 vs 와인)
- 와인 메타데이터 추출 (와이너리, 지역, 포도품종, 빈티지)
- 카테고리별 검색 필터링 (와인/사케/기타)
- HS-CODE 기반 서브 카테고리 분류
- 100% 하위 호환성 (기존 사케 기능 유지)

**최신 버전**: `backend/src/services/gemini.ts` (v294+)

### 주요 개선사항
- ✅ Etc-Wine 검증 프롬프트 수정
- ✅ 메타데이터 우선순위화 후 신뢰도 계산 수정
- ✅ 반복 코드 제거 (헬퍼 함수 추출)
