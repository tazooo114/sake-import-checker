# 프로젝트 헌법 (Project Constitution)

> 이 문서는 프로젝트의 핵심 가치와 원칙을 정의합니다. 모든 구현 결정은 이 헌법을 따라야 합니다.

## 핵심 가치

### 1. 정확도 최우선
- 불확실하면 반드시 "수입 목록에서 찾을 수 없습니다" 명시
- 잘못된 정보 제공보다 "모름" 답변이 낫다
- **확신도 70% 미만은 "불확실" 처리**

### 2. 속도는 차선
- 응답 시간: 10-15초 허용
- 정확도를 위해 3단계 검색 수행
- 빠른 응답보다 정확한 응답

### 3. 사용자 경험
- "분석 중..." 메시지 없음
- 사진에 직접 reply로 결과 전송
- 사진-결과 매칭 명확하게 유지

### 4. 출장 업무 지원
- 연속 사진 업로드 지원
- 병렬 처리 가능
- Rate limit 시 대기 안내

---

## 검색 원칙

### 1. 3단계 하이브리드 검색
- **1단계**: 벡터 검색 (브랜드/제조사 필터링, 상위 10개)
- **2단계**: 메타데이터 매칭 (숫자/용량 정확 비교)
- **3단계**: AI 최종 검증 (사진과 후보 대조)

### 2. 유사 제품 정확히 구분
- **Sake**: 닷사이 23/39/45 등 숫자 정확히 식별
- **Wine**: 와이너리(Exporter)와 생산지(Region), 품종(Grape) 정확히 구분
- 720ml/1800ml 등 용량 정확히 식별
- 같은 브랜드 다른 제품 혼동 방지

### 3. 불확실성 명시
- 후보가 여러 개면 모두 제시하되 "불확실" 명시
- 라벨이 흐릿하거나 불완전하면 재촬영 요청
- 추측성 답변 금지

---

## 기술 원칙

### 1. 서버리스 우선
- Cloudflare Workers 사용
- 무료 티어 내 작동 (10만 요청/월)
- 자동 확장 가능

### 2. 무료 서비스 활용
- Supabase PostgreSQL (무료 500MB)
- Gemini API (무료 또는 저가 pay-as-you-go)
- Cloudflare Pages (무료)
- Telegram Bot (무료)

### 3. 간단한 관리
- Excel 드래그앤드롭으로 업데이트
- 진행률 실시간 표시
- 비개발자(아버지) 사용 가능

### 4. 오류 처리
- 모든 단계에서 명확한 에러 메시지
- Rate limit 도달 시 대기 안내
- 실패 시 재시도 가능

### 5. 배포 명령 제한
- `npx wrangler deploy` 명령은 타임아웃이 빈번함
- AI가 직접 실행하지 않고, 사용자에게 터미널에서 직접 실행하도록 안내
- 배포 완료 후 사용자가 결과를 알려주면 이어서 진행

---

## 데이터 원칙

### 1. 마스터 데이터 관리
- Excel 업로드 시 기존 데이터 전체 삭제
- 새 데이터 전체 임베딩 재생성
- 약 4분 소요 (2445개 기준)
- 진행률 실시간 표시

### 2. 검색 인덱스
- 제품명: 벡터 임베딩 (Gemini text-embedding-004)
- 메타데이터: 
  - Sake: Volume, Category, Exporter, Numbers
  - Wine: Exporter (Winery), Region, Grape, Vintage
- pgvector 코사인 유사도 검색

### 3. 데이터 이력
- 업데이트 시각 기록
- 총 레코드 수 추적
- 마지막 업로드자 기록

---

## 보안 원칙

### 1. API 키 관리
- Telegram Bot Token: Cloudflare Workers Secrets
- Gemini API Key: Cloudflare Workers Secrets
- Supabase 자격증명: Environment Variables

### 2. 관리자 페이지
- 간단한 비밀번호 보호
- HTTPS 필수
- 업로드 파일 검증 (Excel만 허용)

---

## 성능 원칙

### 1. 응답 시간
- 목표: 10-15초
- 최대: 20초
- 타임아웃 시 명확한 안내

### 2. 동시 처리
- 최대 5명 동시 사용
- Queue 시스템으로 Rate limit 관리
- 분당 15개 요청 제한 (Gemini 무료 티어)

### 4. 확장성
- 10,000개 레코드까지 지원
- pgvector 인덱스로 빠른 검색
- Cloudflare Workers 자동 확장

---

## AI 모델 정책 (AI Model Policy)

### 1. 허용 모델 (Allowed Models)
- **Primary**: `gemini-2.5-flash`
- **Fallback**: `gemini-2.0-flash` (안정성 확보용)
- **Embedding**: `gemini-embedding-001`

### 2. 금지 모델 (Prohibited Models)
- **`gemini-3-flash`**: 사용 절대 금지 (현재 환경 미지원)
- **`*antigravity`**: 이름에 antigravity가 포함된 모든 모델 사용 금지
- 실험적(Experimental) 모델 사용 지양

### 3. 모델 선정 기준
- 안정성(Stability)과 가용성(Availability)이 최우선
- 최신 모델이라도 503 에러가 빈번하면 Fallback 모델 사용 필수
