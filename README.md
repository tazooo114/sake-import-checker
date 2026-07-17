# Import Data & Trade Tooling — Portfolio

주류(사케·와인) **수출입 거래 데이터**를 다루면서 만든 도구들과, 그 과정에서 겪은
문제를 서버리스 서비스로 발전시킨 프로젝트를 모은 포트폴리오 저장소입니다.

> ⚠️ 이 저장소에는 **코드와 문서만** 포함됩니다.
> 실제 거래 데이터(엑셀), API 키 등 민감 정보는 `.gitignore`로 제외되어 있습니다.

---

## 📦 프로젝트

### 1. [Sake & Wine Import Checker](./sake-import-checker) — 라벨 사진 기반 수입 이력 검색 봇

일본 현지에서 **사케·와인**을 소싱할 때, 라벨 사진 한 장으로 **한국 수입 이력과 거래 가격**을
즉시 확인하는 텔레그램 봇입니다. 로컬 파이썬 스크립트로만 조회하던 것을 모바일에서
바로 쓸 수 있는 서버리스 서비스로 전환했습니다.

- **주종별 인식**: 사케는 브랜드·용량·제조사, 와인은 와이너리·생산지·품종·빈티지를 라벨에서 추출
- **파이프라인**: Gemini Vision 라벨 추출 → pgvector(HNSW) 벡터 검색 → AI 이미지 비교 검증
- **스택**: Cloudflare Workers · Queues · Cron · Supabase(pgvector) · Google Gemini
- **설계 포인트**: 오인식 방지를 위한 확신도 임계값(70점), 무료 티어 내 운영(목표 월 $0–1)
- 자세한 내용 → [프로젝트 README](./sake-import-checker/README.md) · [설계 문서](./sake-import-checker/docs)

### 2. [Tridge Data Manager](./tridge_data_manager) — 수출입 엑셀 데이터 정제 도구

Tridge 수출입 원본 엑셀을 정제·집계하는 파이썬 도구입니다. Import Checker의
데이터 소스를 만드는 전처리 단계로, 제품명이 한/영/일로 제각각인 데이터를 정규화하고
수입사별로 집계합니다.

- **`data_manager.py`**: 원본 → 정제/집계 파이프라인 (pandas)
- **`tridge_gui.py`**: 비개발자도 쓸 수 있는 데스크톱 GUI
- 입력·출력 엑셀 데이터 자체는 저장소에 포함되지 않습니다.

---

## 🗂 저장소 구조

```
.
├── sake-import-checker/     # 서버리스 텔레그램 봇 (Cloudflare Workers)
│   ├── backend/            #   Workers 백엔드 (TypeScript)
│   ├── admin/              #   관리자 업로드 UI
│   ├── database/           #   Supabase 스키마 / 마이그레이션
│   └── docs/               #   설계·셋업 문서
├── tridge_data_manager/     # 수출입 엑셀 정제 도구 (Python)
├── .specify / .opencode     # spec-driven 개발 워크플로 설정
└── PORTFOLIO_importchecker.md
```

## 🛠 기술 스택

TypeScript · Cloudflare Workers/Queues · Supabase(PostgreSQL + pgvector) ·
Google Gemini · Python(pandas) · Telegram Bot API

## 📄 라이선스 / 이용

포트폴리오 열람 목적으로 공개합니다. 코드 재사용·문의는 별도로 연락 바랍니다.
