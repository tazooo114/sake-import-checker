# Sake & Wine Import Checker

일본 **사케**부터 **와인**까지, 라벨 사진 한 장이면 한국 수입 이력과 거래 가격을
바로 확인할 수 있는 텔레그램 봇입니다. 현지에서 소싱할 때 "이 술, 한국에 이미 들어와 있나?
얼마에 거래됐나?"를 즉석에서 조회하는 것이 목표입니다.

주종을 자동으로 판별해, 라벨에서 뽑아내는 정보와 검색 우선순위가 알맞게 달라집니다.

| 주종 | 라벨에서 추출하는 정보 |
| --- | --- |
| **사케** | 브랜드(한/영/일) · 숫자 · 용량 · 제조사(Exporter) |
| **와인** | 와이너리(Winery) · 생산지(Region) · 품종(Grape) · 빈티지(Vintage) — 와이너리 우선 검색 |

## 동작 방식 — Triple Search (3중 검색)

라벨 사진 한 장이 세 단계를 거쳐 가장 가능성 높은 수입 제품으로 좁혀집니다.

1. **Vision Extraction** — 라벨 이미지를 Gemini Vision으로 분석해 주종을 판별하고,
   위 표의 항목들을 텍스트로 추출합니다.
2. **Vector Search** — 추출한 키워드와 메타데이터를 조합해 pgvector(HNSW) 인덱스로
   의미 기반 정밀 검색을 수행합니다.
3. **AI Verification** — 상위 후보 제품의 이미지와 사용자가 보낸 사진을 AI가 최종 비교·검증합니다.
   확신도가 충분히 높으면(High Confidence Skip) 검증을 건너뛰고 즉시 결과를 반환합니다.

## 주요 기능

- **사진 검색**: 사케·와인 라벨 촬영 한 번으로 수입 이력과 거래 가격 확인 (Gemini 2.5 Flash / 2.0 Flash)
- **스마트 데이터 관리**:
  - **Smart Update**: 기존 제품은 정보만 갱신하고, 신규 제품만 AI 분석 (비용 절감 & 속도 향상)
  - **Chunked Upload**: 대량 데이터를 50개 단위로 나눠 안정적으로 업로드
  - **Auto Retry**: 타임아웃 시 자동 재시도 (최대 5회, 지수 백오프 2초 → 32초)
  - **Upload Control**: 업로드 중지 / 이어하기 지원
- **안정성**: PostgreSQL RPC 함수로 대량 UPDATE 최적화, COALESCE 기반 인덱스 적용

## 기술 스택

- **Backend**: Cloudflare Workers (TypeScript, Hono)
- **Database**: Supabase PostgreSQL + pgvector (HNSW Index)
- **AI Analysis (Google Gemini)**:
  - **Vision Model**: `gemini-2.5-flash` (Primary) / `gemini-2.0-flash` (Fallback)
  - **Embedding Model**: `gemini-embedding-001` (Output Dimension: 768)
  - 라벨 이미지에서 텍스트/키워드 추출 → 시맨틱 검색용 벡터 임베딩 생성 →
    질의 이미지와 후보 제품 이미지의 시각적 유사도 검증
  - **Auto-Retry**: 분석 실패 시 최대 2회 자동 재시도
- **Interface**: Telegram Bot API (Webhook)
- **Frontend**: Cloudflare Pages (Admin UI)

## 빠른 시작

### 1. 의존성 설치
```bash
cd backend
npm install
```

### 2. 환경변수 설정
```bash
# Wrangler Secret 설정
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put GEMINI_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_KEY
wrangler secret put ADMIN_PASSWORD
```

### 3. 로컬 개발
```bash
npm run dev
```

### 4. 배포
```bash
./scripts/deploy.sh
```

## 프로젝트 구조

```
sake-import-checker/
├── backend/          # Cloudflare Workers (API & Bot Logic)
│   ├── src/
│   │   ├── handlers/ # API 핸들러 (Telegram, Admin)
│   │   ├── services/ # 비즈니스 로직 (Search, Gemini)
│   │   ├── utils/    # 유틸리티
│   │   └── types/    # TypeScript 타입
│   └── wrangler.toml
├── admin/            # 관리자 페이지 (Cloudflare Pages)
├── database/         # SQL 스키마 및 마이그레이션
└── docs/             # 문서
```

## 구성도

```
   [ 쓰기 경로 ]                       [ 읽기 경로 ]

   관리자 브라우저                      텔레그램 사용자
        │ .xlsx 파싱 후 50행 청크            │ 라벨 사진
        ▼                                   ▼
   Worker  /admin/upload-chunk         Worker  /telegram-webhook
   · 복합키로 UPDATE/INSERT 분리        · 즉시 200, 백그라운드 enqueue
   · 신규는 임베딩 없이 INSERT               │
        │                                   ▼
        │ {id, 임베딩텍스트}            photo-search-queue
        ▼                                   │
   embedding-queue                          ▼
        │                              Queue Consumer
        ▼                              · Gemini Vision (라벨 추출)
   Queue Consumer                      · 벡터 검색 + 재정렬
   · Gemini Embedding                  · Gemini Vision (재검증)
   · UPDATE name_embedding                  │
        │                                   │
        └──────▶ Supabase ◀─────────────────┘
                 PostgreSQL + pgvector
```

**Gemini 호출은 양쪽 모두 큐 컨슈머에서만 일어납니다.** HTTP 요청이 도달하는 엣지 위치에서는 Gemini가 지역 제한으로 거절하기 때문입니다 ([ARCHITECTURE 3.7](docs/ARCHITECTURE.md#37-gemini-호출이-전부-큐-컨슈머에-있는-이유)).

## 문서

- [왕초보 설치 가이드](docs/BEGINNER_GUIDE.md) - **추천!**
- [아키텍처](docs/ARCHITECTURE.md) - 조회/적재 두 흐름과 단계별 데이터 변환
- [기술 설치 가이드](docs/SETUP.md)
- [개선 이력·우선순위](docs/feedback.md) - 코드 리뷰 결과와 진행 상태
- [프로젝트 헌법](constitution.md)
- [기능 명세서](spec.md)
- [구현 계획](plan.md)

### 문서 지도 — 무엇을 바꾸면 무엇을 갱신하는가

이 저장소의 고질적 문제가 **코드·문서·실제 배포가 서로 어긋나는 것**입니다. 코드를 고쳤으면 아래 표에서 해당 행을 찾아 문서도 같이 갱신하세요.

| 바꾼 것 | 같이 갱신할 문서 |
|---|---|
| 검색·재정렬 로직 (`services/search.ts`) | ARCHITECTURE 2.3 · feedback.md |
| Gemini 모델·프롬프트·토큰 (`services/gemini.ts`) | ARCHITECTURE 2장 · feedback.md 2장 |
| 업로드·적재 (`handlers/admin.ts`, `admin/js/upload.js`) | ARCHITECTURE 3장 (구성도 포함) |
| 큐 구성 (`wrangler.toml`, `handlers/*Queue*.ts`) | ARCHITECTURE 1·3.7 · SETUP 큐 생성 절 · 이 README 구성도 |
| DB 스키마·RPC (`database/*.sql`) | ARCHITECTURE 5장 · SETUP 1절 · spec.md 4장 |
| 엔드포인트 추가·삭제 (`index.ts`) | SETUP 운영 엔드포인트 절 · ARCHITECTURE 4장 |
| 배포·시크릿·Node 버전 절차 | SETUP · 저장소 루트 `CLAUDE.md` |
| 개선 항목의 진행 상태 | feedback.md 8장 우선순위표 |

**PDF는 자동 생성물이 아니라 수동 산출물입니다.** `docs/*.pdf`는 대응하는 `.md`를 고쳐도 갱신되지 않으므로, 배포용으로 쓸 때 다시 만들어야 합니다.

## 라이선스

Private
