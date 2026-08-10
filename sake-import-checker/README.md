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

## 문서

- [왕초보 설치 가이드](docs/BEGINNER_GUIDE.md) - **추천!**
- [아키텍처](docs/ARCHITECTURE.md) - 조회/적재 두 흐름과 단계별 데이터 변환
- [기술 설치 가이드](docs/SETUP.md)
- [프로젝트 헌법](constitution.md)
- [기능 명세서](spec.md)
- [구현 계획](plan.md)

## 라이선스

Private
