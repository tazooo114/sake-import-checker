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

### 4.3 큐 생성 (배포 전에 필요)

`wrangler.toml`이 큐 4개를 참조합니다. **큐가 없으면 `wrangler deploy`가 실패합니다.**

| 큐 | 역할 |
|---|---|
| `photo-search-queue` | 사진 검색 요청을 1건씩 순차 처리 |
| `photo-search-dlq` | 사진 검색 최종 실패분 |
| `embedding-queue` | 엑셀 업로드의 임베딩 생성 |
| `embedding-dlq` | 임베딩 최종 실패분 |

```bash
wrangler queues create photo-search-queue
wrangler queues create photo-search-dlq
wrangler queues create embedding-queue
wrangler queues create embedding-dlq
```

> **함정 — 설치된 wrangler로는 큐 생성이 안 됩니다.**
> 이 프로젝트에 고정된 wrangler 4.54는 `queues create`가 `The specified queue settings are invalid.`(API 400)로 실패합니다. `wrangler.toml` 문제가 아니라 그 버전 자체의 문제이며, 다른 디렉터리에서 실행해도 같습니다. `queues list`나 `deploy` 같은 다른 큐 명령은 정상 동작합니다.
>
> 큐를 만들 때만 최신 wrangler를 일회성으로 씁니다. 최신 wrangler는 Node 22+를 요구하므로 v24가 필요합니다:
>
> ```bash
> export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
> npx -y wrangler@latest queues create embedding-queue
> ```
>
> 배포·로그 등 나머지 작업은 계속 Node 20 + 설치된 wrangler로 합니다.
>
> 에러 상세를 보려면 `WRANGLER_LOG_SANITIZE=false`가 필요한데, 그러면 **인증 토큰이 로그 파일에 평문으로 남으므로 쓰지 마세요.**

**왜 큐가 두 쌍인가**: 업로드 한 번이 메시지 수십~수백 건을 밀어넣습니다. 사진 큐(`max_batch_size = 1`)를 공유하면 그 뒤에 들어온 사용자 사진이 전부 소진될 때까지 대기하게 됩니다. 그리고 Gemini 호출을 큐 컨슈머에 두는 이유는 지역 제한입니다 — [ARCHITECTURE 3.7절](./ARCHITECTURE.md#37-gemini-호출이-전부-큐-컨슈머에-있는-이유) 참고.

### 4.4 배포
```bash
wrangler deploy
```

배포 후 URL 확인 (예: `https://sake-import-checker.your-subdomain.workers.dev`)

출력의 바인딩 목록에 `env.PHOTO_QUEUE`와 `env.EMBED_QUEUE`가, 트리거 목록에 두 큐의 Producer/Consumer가 모두 보여야 정상입니다.

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

### 5.2 봇 토큰을 모를 때 — Worker가 직접 등록

`setWebhook`에는 봇 토큰과 `secret_token`이 모두 필요한데, 둘 다 Worker가 이미 시크릿으로 갖고 있습니다. 토큰을 찾아와 셸에 입력할 필요 없이 관리자 엔드포인트를 호출하면 됩니다.

```bash
# ① Worker에 secret 등록 (stdin으로 받으므로 히스토리에 안 남는다)
cd backend && export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# ② Worker가 자기 웹훅을 Telegram에 등록
curl -s -X POST "https://sake-import-checker.<subdomain>.workers.dev/admin/set-webhook" \
  -H "Authorization: Bearer <ADMIN_PASSWORD>"
```

성공하면 `{"ok":true,"url":"...","secretConfigured":true}`가 돌아옵니다.

> **순서 주의**: ①과 ② 사이에는 Worker가 헤더를 요구하는데 Telegram은 아직 보내지 않는 구간이 생겨, 그동안 들어온 메시지가 무시됩니다. 두 명령을 연달아 실행하면 몇 초입니다. 봇 토큰을 알고 있어 무중단으로 하고 싶다면 5.1의 수동 `setWebhook`을 먼저 하고 그 다음 ①을 하세요.

봇 토큰을 직접 확인해야 한다면 Telegram에서 **@BotFather → `/mybots` → 봇 선택 → API Token**. **Revoke는 누르지 마세요** — 새 토큰이 발급되면 `TELEGRAM_BOT_TOKEN` 시크릿도 함께 갱신해야 합니다.

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
   - ✅ **업로드 직후에는 아직 검색되지 않습니다.** 임베딩은 큐가 비동기로 채웁니다 (아래 7.5 참고)

### 7.5 임베딩 적재 확인

업로드 응답의 200은 "저장됐다"이지 "검색 가능해졌다"가 아닙니다. `name_embedding`이 채워져야 검색에 잡힙니다.

```bash
curl -H "Authorization: Bearer <ADMIN_PASSWORD>" \
  https://<worker>.workers.dev/admin/embedding-status
```

- 업로드 직후: `pending`이 0보다 큽니다 (정상)
- 큐 소진 후: `pending`이 **0으로 수렴**해야 합니다
- 계속 0이 아니면: `embedding-dlq`를 확인하세요. 그 행들은 검색에 영원히 잡히지 않습니다

`wrangler tail`에서 볼 로그:

```
[COLO] queue/embed — colo=SJC loc=US      ← Gemini 허용 지역이어야 함
[EMBED] Generating 50 embeddings
[EMBED] Filled 50/50 embeddings           ← 두 수가 같아야 정상
```

`Filled 0/50`처럼 어긋나면 id 매칭이 틀린 것입니다. 데이터가 유실된 건 아니고 해당 행의 임베딩만 비어 있는 상태입니다.

---

## 운영·진단 엔드포인트

모두 `Authorization: Bearer <ADMIN_PASSWORD>`가 필요합니다.

| 엔드포인트 | 용도 |
|---|---|
| `GET /health` | 생존 확인. 실행 colo도 함께 반환 (인증 불필요) |
| `GET /admin/stats` | 총 건수·최종 갱신일·상위 수출사 |
| `GET /admin/embedding-status` | 임베딩이 채워지지 않은 행 수와 샘플 |
| `POST /admin/embed-selftest` | **DB를 바꾸지 않고** 임베딩 큐 경로 전체를 점검 |
| `GET /admin/colo-probe?n=20` | 실행 colo와 Gemini 통과 여부를 함께 측정 |
| `POST /admin/set-webhook` | 웹훅 URL·secret 등록 (5.2절) |
| `POST /admin/eval` | 검색 평가 하네스 실행 |

### 업로드가 지역 제한으로 막힐 때

`User location is not supported for the API use`가 보이면 실행 PoP이 Gemini 비허용 지역입니다. 진단:

```bash
curl -H "Authorization: Bearer <ADMIN_PASSWORD>" \
  "https://<worker>.workers.dev/admin/colo-probe?n=20"
```

`colo`가 `HKG`(홍콩)면 100% 막힙니다. 다만 **업로드 자체는 이 영향을 받지 않습니다** — 임베딩은 큐 컨슈머에서 만들기 때문입니다. 큐 컨슈머 쪽 colo는 `POST /admin/embed-selftest` 후 `wrangler tail`의 `[COLO] queue/embed`로 확인합니다.

배경과 실측값은 [ARCHITECTURE 3.7절](./ARCHITECTURE.md#37-gemini-호출이-전부-큐-컨슈머에-있는-이유) 참고.

### 시크릿을 셸에 직접 타이핑하지 마세요

위 예시의 `<ADMIN_PASSWORD>`를 그대로 명령줄에 치면 셸 히스토리에 남습니다. 히스토리에 남기지 않는 형태:

```bash
read -rs "?admin password: " PW && curl -s -H "Authorization: Bearer $PW" \
  https://<worker>.workers.dev/admin/embedding-status; unset PW
```

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
