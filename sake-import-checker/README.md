# Sake & Wine Import Checker

사케와 와인 라벨 사진으로 한국 수입 이력을 검색하는 텔레그램 봇입니다.

## 주요 기능

- **사진 검색**: 사케/와인 라벨 촬영 → 수입 이력/가격 확인 (Gemini 2.5 Flash / 2.0 Flash)
- **Triple Search (3중 검색)**:
  1. **Vision Extraction**:
     - **Sake**: 브랜드(한/영/일), 숫자, 용량, 제조사(Exporter) 추출
     - **Wine**: 와이너리(Exporter), 생산지(Region), 품종(Grape), 빈티지(Vintage) 추출 (Winery 우선순위 Search)
  2. **Vector Search**: 추출된 모든 키워드와 메타데이터를 조합하여 HNSW 인덱스 기반 정밀 검색
  3. **AI Verification**: 검색된 후보 제품의 이미지와 사용자 사진을 AI가 최종 비교 검증 (High Confidence Skip 적용 시 즉시 반환)
- **스마트 데이터 관리**:
  - **Smart Update**: 기존 제품은 정보만 갱신, 신규 제품만 AI 분석 (비용 절감 & 속도 향상)
  - **Chunked Upload**: 대량 데이터도 50개씩 나누어 안정적으로 업로드
  - **Auto Retry**: 타임아웃 시 자동 재시도 (5회, 지수 백오프 2초→32초)
  - **Upload Control**: 업로드 중지/이어하기 기능
- **안정성**: PostgreSQL RPC 함수로 대량 UPDATE 최적화, COALESCE 기반 인덱스 적용

## 기술 스택

- **Backend**: Cloudflare Workers (TypeScript, Hono)
- **Database**: Supabase PostgreSQL + pgvector (HNSW Index)
### 3. AI Analysis (Google Gemini)
- **Vision Model**: `gemini-2.5-flash` (Primary) / `gemini-2.0-flash` (Fallback)
- **Embedding Model**: `gemini-embedding-001` (Output Dimension: 768)
- **Logic**:
  - Extracts text/keywords from label images
  - Generates vector embeddings for semantic search
  - Verifies visual similarity between query image and candidates
  - **Auto-Retry**: Automatically retries analysis up to 2 times for robust results
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
- [기술 설치 가이드](docs/SETUP.md)
- [프로젝트 헌법](constitution.md)
- [기능 명세서](spec.md)
- [구현 계획](plan.md)

## 라이선스

Private
