# 포트폴리오 — 프로젝트 섹션

## Sake & Wine Import Checker — 주류 라벨 사진 기반 수입 이력 검색 텔레그램 봇

### 문제

- 일본 현지에서 사케·와인을 소싱할 때, 해당 제품이 한국에 수입된 이력과 거래 가격을 현장에서 바로 확인할 방법이 없었습니다.
- 기존에는 로컬 PC에서 파이썬 스크립트로 Tridge 수출입 엑셀 데이터를 조회해야 해서 모바일 환경에서 사용할 수 없었습니다.
- 제품명이 한글·영어·일본어(한자)로 표기가 제각각이라 단순 문자열 검색으로는 매칭이 어려웠습니다.

### 접근

- 로컬 파이썬 스크립트를 서버리스(Cloudflare Workers) 기반 텔레그램 봇으로 전환했습니다.
- 라벨 사진 1장으로 검색이 끝나도록 3단계 파이프라인을 설계했습니다: ① Gemini Vision으로 라벨 정보 추출 → ② pgvector 벡터 검색 → ③ 후보 이미지 AI 비교 검증.
- 오인식으로 잘못된 가격 정보를 주는 것을 막기 위해, 검증 확신도 70점 미만이면 "찾을 수 없음"으로 응답하도록 했습니다.
- 무료 티어(Cloudflare Workers, Supabase, Gemini 종량제) 범위 안에서 운영하는 것을 제약 조건으로 두었습니다(목표 월 $0–1).

### 아키텍처 및 해결 방법

| 구성 요소 | 기술 | 역할 |
|---|---|---|
| 인터페이스 | Telegram Bot API (Webhook) | 사진/텍스트 수신, 결과 응답 |
| 백엔드 | Cloudflare Workers + Hono (TypeScript) | 검색 파이프라인, 관리자 API |
| 비동기 처리 | Cloudflare Queues | 사진 1장씩 순차 처리 (batch size 1, 재시도 3회, DLQ) |
| AI | Gemini 2.5 Flash (폴백: 2.0 Flash), gemini-embedding-001 | 라벨 추출·이미지 검증·임베딩 생성 |
| DB | Supabase PostgreSQL + pgvector | halfvec(768) 임베딩 저장, HNSW 인덱스 검색 |
| 관리자 UI | Cloudflare Pages (Vanilla JS + Tailwind) | 엑셀 업로드, 통계 조회 |
| 데이터 전처리 | Python (pandas) | Tridge 원본 엑셀 병합·정제 (`tridge_data_manager`) |

```mermaid
flowchart TD
    A["사용자 사진<br/>(텔레그램 전송)"] --> B["Telegram Webhook<br/>(Cloudflare Workers)"]
    B --> C["Cloudflare Queue<br/>(1장씩 순차 처리)"]
    C --> D["Gemini Vision 추출<br/>(브랜드 · 제조사 · 용량 등)"]
    D --> E["pgvector 벡터 검색<br/>(HNSW, Top 50)"]
    E --> F["메타데이터 재정렬<br/>(제조사 · 숫자 매칭 점수)"]
    F --> G{"유사도 판정"}
    G -- "≥ 0.82<br/>(또는 ≥ 0.75 & 2위와 격차 > 0.15)" -.->|"High Confidence Skip<br/>AI 검증 생략"| I
    G -- "그 외" --> H["AI 검증<br/>(상위 3개 후보 이미지 비교,<br/>확신도 70점 이상만 확정)"]
    H --> I["응답<br/>(제품명 · 수입사 · 가격)"]

    style G stroke-width:2px
    linkStyle 6 stroke-width:2px
```

> 그림 1. 검색 파이프라인. 벡터 유사도가 기준을 넘으면 AI 검증 단계를 생략해 Gemini API 호출 1회를 줄이고 응답 시간을 단축합니다.

**검색 파이프라인**

- Vision 추출: 제품 타입(사케/와인)을 감지하고 타입별로 다른 필드를 추출했습니다. 사케는 브랜드(한/영/일)·숫자·용량·제조사, 와인은 와이너리·생산지·품종·빈티지입니다.
- 벡터 검색: 추출 키워드를 조합해 768차원 임베딩을 생성하고, HNSW 인덱스(m=24, ef_construction=128)로 코사인 유사도 상위 50개 후보를 조회했습니다.
- 메타데이터 재정렬: 제조사 완전 일치 100점, 부분 일치 80점, 단어 단위 매칭 20점/단어 등 점수제로 후보 순위를 조정했습니다.
- AI 검증: 상위 3개 후보와 원본 사진을 Gemini에 비교 요청하고, 확신도 70점 이상일 때만 결과로 확정했습니다. 유사도 0.82 이상(또는 0.75 이상이면서 2위와 격차 0.15 초과)이면 검증 단계를 생략해 API 비용과 응답 시간을 줄였습니다.

**안정성 처리**

- 사진 여러 장 동시 전송 시 Gemini Rate Limit(429)으로 첫 장만 처리되던 문제를 Cloudflare Queues 도입으로 해결했습니다.
- Gemini API 무응답으로 Worker가 강제 종료되던 문제에 명시적 타임아웃(생성 20초, 임베딩 10초)을 적용했습니다.
- 라벨 추출 결과가 불안정한 경우 최대 2회 재시도하되, 추출 확신도가 70점 이상이면 재시도를 생략해 응답 지연을 방지했습니다.
- 엑셀 업로드는 50건 단위 청크로 분할해 Workers의 실행 시간 제한을 회피했고, 실패 시 지수 백오프(2초 시작, 최대 3회)로 재시도했습니다.
- 제품명+제조사+원산지+수입사 4개 필드 복합 키로 기존/신규 레코드를 구분해, 기존 제품은 가격만 갱신하고 신규 제품만 임베딩을 생성했습니다(Smart Update). 기존 제품 갱신은 단일 RPC 호출로 일괄 처리했습니다.
- 6시간 주기 Cron으로 Supabase 무료 티어의 프로젝트 자동 정지를 방지했습니다.

### 결과

- 라벨 사진 1장으로 한국 수입 이력·수입사·거래 가격을 조회하는 봇을 배포했습니다 (응답 시간 목표 10–15초).
- 임베딩을 halfvec(768차원)으로 저장해 벡터 저장 용량을 절반으로 줄였습니다 (3072차원 출력을 768로 절단).
- Cloudflare Workers·Supabase 무료 티어와 Gemini 종량제 조합으로 운영했습니다 (설계 목표 월 $0–1).
- Queue 도입 후 사진 30장 이상 동시 전송 시에도 전량 순차 처리되는 것을 확인했습니다.
- IVFFlat → HNSW 인덱스 전환, RLS 적용, 함수 search_path 고정 등 DB 마이그레이션 8건을 SQL 스크립트로 관리했습니다.

**기술 스택**: TypeScript, Cloudflare Workers, Hono, Cloudflare Queues, Cloudflare Pages, Supabase PostgreSQL, pgvector, Google Gemini API, Telegram Bot API, Python, pandas, Vitest
