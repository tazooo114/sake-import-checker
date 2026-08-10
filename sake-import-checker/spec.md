# 프로젝트 사양서: Sake Search & Import Manager

## 1. 개요

### 프로젝트명
**Monodream Sake Search Bot**

### 목적
현장(일본)에서 사케 라벨을 촬영하면, 즉시 한국 수입 여부와 가격 정보를 제공하는 텔레그램 봇 서비스입니다. 기존 로컬 파이썬 스크립트(`analyze_tridge.py`)를 클라우드 네이티브(Serverless) 환경으로 전환하여 모바일 접근성과 유지보수 편의성을 극대화합니다.

### 핵심 가치
- **확장된 검색 범위**: 사케뿐만 아니라 와인 등 주류 전반으로 검색 지원 (Sake/Wine 자동 감지)
- **정확도 최우선**: 불확실시 "모름" 응답 (70% 미만 확신)
- **현장 업무 최적화**: 사진 검색, 연속 업로드 지원
- **유지보수 제로**: 엑셀 업로드 한 번으로 데이터/임베딩 자동 갱신

---

## 2. 기술 스택

### 백엔드
- **Cloudflare Workers** (TypeScript)
  - 서버리스 함수
  - 자동 확장
  - 무료 10만 요청/월
  - Edge computing (글로벌 빠른 응답)
  - **Keepalive**: 6시간마다 Health Check (Supabase 프로젝트 정지 방지)

### 데이터베이스
- **Supabase PostgreSQL**
  - 무료 500MB (현재 사용량: ~55%)
  - **pgvector (halfvec)**: 임베딩 용량 50% 절감
  - REST API 자동 생성
  - 실시간 진행률 추적
  - **Security**: RLS(Row Level Security) 및 Function Search Path 고정 적용

### AI/ML
- **Google Gemini API**
  - Vision: 라벨 이미지 분석 (2.5 Flash)
  - Embedding: 텍스트 벡터화 (gemini-embedding-001, 3072차원 → 768로 축소)
  - **Pay-as-you-go**: Rate Limit 제한 없이 고속 처리

### Data Processing Tools
- **Tridge Data Manager** (Python)
  - CLI/GUI Hybrid (`data_manager.py` shared logic)
  - Excel Pre-processing & Analysis

### 프론트엔드
- **Telegram Bot API**
  - 크로스플랫폼 (iOS/Android)
  - Webhook 방식

- **Cloudflare Pages** (관리자 페이지)
  - HTML + Vanilla JS
  - Tailwind CSS
  - Excel 업로드 UI

---

## 3. 사용자 스토리

### 현장 요원 (User)
| 액션 | 결과 |
|------|------|
| 사케 병 사진을 텔레그램으로 전송 | 15초 이내에 제품명, 수입사, 카테고리, 최고 거래가 정보를 받음 |
| 텍스트(예: "닷사이")로 검색 | 유사한 제품 목록을 확인 |
| 검색 결과가 불확실할 경우 | "확인 불가" 메시지를 받아 오인식 방지 |

### 관리자 (Admin)
| 액션 | 결과 |
|------|------|
| Smart Update (기본) | 기존 제품은 정보(가격 등)만 업데이트, 신규 제품만 임베딩 생성 (비용/시간 절약) |
| Full Reset | 기존 데이터를 모두 삭제하고 전체 재분석 |
| Excel 청크 업로드 | 50개 단위 순차 업로드로 Cloudflare Worker 30초 제한 회피 |

---

## 4. 데이터베이스 스키마

### `sake_imports` 테이블
```sql
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
  name_embedding halfvec(768), -- Halfvec for 50% storage saving
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### `upload_progress` 테이블
```sql
CREATE TABLE upload_progress (
  session_id TEXT PRIMARY KEY,
  current_count INT DEFAULT 0,
  total_count INT DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### `search_logs` 테이블
```sql
CREATE TABLE search_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  query_text TEXT,
  photo_file_id TEXT,
  matched_product_id BIGINT,
  confidence_score FLOAT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 5. 검색 알고리즘 (Triple Search Strategy)

### Step 1: Vision Extraction
Gemini 2.5 Flash가 이미지를 분석하여 제품 타입(Sake/Wine)을 자동 감지하고 맞춤 정보를 추출합니다.

### 4.2. Embedding Generation (`backend/src/services/gemini.ts`)
- **Model**: `gemini-embedding-001`
- **Dimension**: 768 (Truncated from 3072)
- **Input**:
    - **Sake**: `brand` + `brandKorean` + `brandEnglish` + `exporterEnglish` + `rawText`
    - **Wine**: `exporterEnglish` + `region` + `grapeVariety` + `vintage` + `brand` + ...
- **Output**: `number[]` (Length: 768)

**Sake (사케) 모드:**
```typescript
{
  productType: "Sake",
  brand: string,         // 원어 이름 (라벨 그대로)
  brandKorean: string,   // 한글 발음 (예: 닷사이)
  exporterEnglish: string, // 제조사 영어 표기 (예: Asahi Shuzo) - 검색 핵심 키워드
  numbers: string[],     // ["23", "39", "45"]
  volume: string,        // "720ml", "1800ml"
  rawText: string        // 원본 텍스트
}
```

**Wine (와인) 모드:**
```typescript
{
  productType: "Wine",
  exporterEnglish: string, // 와이너리/생산자 (예: Château Margaux) - 최우선 검색 키워드
  region: string,          // 생산지 (예: Bordeaux)
  grapeVariety: string,    // 품종 (예: Cabernet Sauvignon)
  vintage: string,         // 빈티지 (예: 2018)
  brand: string,           // 제품명
  rawText: string
}
```

### 4.3. Search Algorithm (`backend/src/services/search.ts`)
1. **Fetch Image**: Download and convert to Base64 (Max 5MB).
2. **Label Extraction (Retryable)**:
   - Extract info using Gemini Vision.
   - If extraction fails or yields no valid keys, retry (Max 2 attempts).
3. **Vector Search**:
   - Generate embedding from extracted text.
   - Query Supabase `sake_imports` table (`cos` distance, threshold 0.5).
4. **Metadata Prioritization**:
   - Boost scores based on exact matches (Winery/Exporter name, Region, etc.).
5. **Visual Verification**:
   - Ask Gemini Vision to verify match between query image and top 3 candidates.
   - **Confidence Score**: 0-100.
   - **Threshold**: 70 (Confirmed Match).

### Step 2: Vector Search
`gemini-embedding-001`로 임베딩 생성 후 Supabase HNSW 인덱스 검색 (Top 50).
- **Sake**: `[한글] [영어] [제조사] [원본]` 조합
- **Wine**: `[와이너리] [지역] [품종] [빈티지] [이름]` 조합 (와이너리 비중 높음)

### Step 3: Metadata Prioritization
검색된 후보군 내에서 메타데이터 일치도에 따라 점수(Score)를 부여하고 재정렬합니다.

- **Sake Logic**:
  - `numbers`(숫자)가 포함된 제품 우선 (예: "39" 검색 시 "39" 포함 제품 승격)
  - `volume`(용량) 일치 여부 확인

- **Wine Logic**:
  - **1순위 (100pt)**: Winery(Exporter) 이름 일치 (가장 강력한 시그널)
  - **2순위 (50pt)**: Region(지역) 또는 Grape(품종) 일치
  - **3순위 (30pt)**: Vintage(빈티지) 일치

### Step 4: Final Verification
상위 3개 후보(Top 3)와 원본 이미지를 Gemini에게 비교 요청하여 최종 확정.
확신도(Confidence) 70% 이상일 때만 정답으로 채택.

**Optimization (High Confidence Skip):**
다음 조건 만족 시 AI 검증 단계를 생략하고 즉시 결과를 반환하여 비용과 시간을 절약함:
- 점수(Score) >= 0.82 (압도적 일치)
- 또는 점수 >= 0.75 AND 1,2위 격차(Gap) > 0.15 (확실한 우위)

---

## 6. API 엔드포인트

### Telegram Webhook
```
POST /telegram-webhook
```

### Admin API
```
POST /admin/upload-init  # (Full Reset 전용) DB 초기화 (TRUNCATE RPC 사용으로 고속화)
POST /admin/upload-chunk # 50개 단위 데이터 업로드 (Smart Upsert)
GET  /admin/stats        # 통계 조회
```

### Health Check
```
GET /health
```

---

## 7. 성능 요구사항

| 지표 | 목표값 |
|------|--------|
| 응답 시간 | 10-15초 |
| 최대 응답 시간 | 20초 |
| 동시 처리 | 5명 |
| Rate Limit | 15 요청/분 |
| 지원 레코드 수 | 최대 50,000개+ |

---

## 8. 비용 예측

| 서비스 | 무료 티어 | 예상 사용량 | 비용 |
|--------|----------|------------|------|
| Cloudflare Workers | 10만 요청/월 | 1,000 요청/월 | $0 |
| Supabase | 500MB | 230MB (최적화 후) | $0 |
| Gemini API | 분당 15개 | 1,000개/월 | $0 |
| **총 예상 비용** | | | **$0-$1/월** |
