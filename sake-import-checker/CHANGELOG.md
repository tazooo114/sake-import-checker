# 수정 이력 (Revision History)


## 2026-01-29 (오류 수정 및 안정성 개선)

### 1. 이미지 검색 오류 수정
- **증상**: 텔레그램 봇에서 이미지 검색 시 "일시적인 오류" 메시지 발생 및 500 에러.
- **원인**:
  - `searchProduct` 함수에서 AI 임베딩 API 호출 실패 시 발생하는 예외를 잡지 못함.
  - 사용 중이던 모델 `text-embedding-004`가 API 키에서 지원되지 않음 (404 Not Found).
- **해결**:
  - `search.ts`: `try-catch` 블록을 추가하여 예외 처리 강화.
  - `gemini.ts`: 임베딩 모델을 `gemini-embedding-001`으로 변경.

### 2. DB 및 모델 최적화
- **증상**: 새로운 모델(`gemini-embedding-001`)의 벡터 차원(3072)이 기존 DB(768)와 맞지 않음.
- **해결**:
  - 모델의 차원 축소(Truncation) 기능을 사용하여 출력 차원을 **768로 설정**.
  - DB 스키마 변경 없이 기존 테이블 그대로 사용 가능하도록 최적화.

### 3. 보안 정책(RLS) 해결
- **증상**: 데이터 업로드 시 "new row violates row-level security policy" 에러 발생.
- **원인**: 백엔드 봇이 쓰기 권한이 없는 익명(anon) 키를 사용함.
- **해결**:
  - Cloudflare Secrets에 관리자 권한인 **Service Role Key** 적용.

### 4. 검색 안정성 강화 (재시도 로직)
- **증상**: 동일한 사진임에도 라벨 인식 결과에 따라 검색 성공/실패가 갈리는 불안정성.
- **해결**:
  - `search.ts`: 검색 실패 또는 신뢰도가 낮을 경우, 자동으로 최대 2회까지 재시도하는 로직 추가.


## 2026-02-04 (서버 유지보수 및 자동화 복구)

### 1. Supabase Keepalive 자동화 복구
- **증상**: Supabase 장기 미사용으로 프로젝트가 일시 정지됨. Keepalive 크론이 동작하지 않음.
- **원인**:
  - `wrangler.toml`에 설정된 크론 스케줄(`0 */6 * * *`)과 `index.ts`의 핸들러 조건(`0 12 * * *`)이 일치하지 않음.
  - 이로 인해 스케줄링된 이벤트가 발생해도 핸들러가 실행되지 않고 무시됨.
- **해결**:
  - `backend/src/index.ts`: 크론 핸들러의 조건을 `0 */6 * * *`로 수정하여 `wrangler.toml` 설정과 일치시킴.
  - 디버깅 및 하위 호환성을 위한 레거시 조건(`0 12 * * *`)에 대한 예외 처리 로직 추가.


## 2026-02-16 (시스템 안정화, 보안 강화 및 사용자 경험 개선)

### 1. 봇 무한 대기(Hang) 버그 수정
- **증상**: "라벨을 분석하고 있습니다..." 메시지 후 봇이 아무런 응답 없이 멈춤.
- **원인**:
  - Gemini API 호출 시 네트워크 지연이나 응답 없음 상태에서 타임아웃 처리가 되어있지 않음.
  - 이로 인해 Cloudflare Workers의 실행 시간(CPU Time) 초과로 프로세스가 강제 종료됨.
- **해결**:
  - `gemini.ts`: `generateContent` 및 `getEmbedding` 함수에 명시적인 타임아웃(20초, 10초) 로직 추가 (`Promise.race`).
  - 타임아웃 발생 시 적절한 에러 메시지를 반환하도록 수정.

### 2. 검색 로직 최적화
- **증상**: 이미지가 명확하여 라벨 분석이 잘 되었음에도 DB에 제품이 없으면 불필요한 재시도를 수행하여 응답이 늦어짐.
- **해결**:
  - `search.ts`: 라벨 분석 신뢰도가 높음(70점 이상)인 경우, 제품을 찾지 못하더라도 재시도(Retry)를 건너뛰고 즉시 결과를 반환하도록 개선.
  - 불필요한 API 호출을 줄이고 응답 속도 향상.

### 3. 사용자 피드백 강화
- **증상**: 제품을 찾지 못했을 때("수입 목록에서 찾을 수 없습니다"), 봇이 라벨을 제대로 읽었는지 사용자가 알 수 없음.
- **해결**:
  - `formatter.ts`: 분석 신뢰도가 높은 경우, 검색 실패 시에도 **[분석된 라벨 정보]**(제품명, 제조사, 용량 등)를 함께 표시.
  - 정보 표시 순서를 `[결과 메시지] -> [분석 정보] -> [유사 제품]`으로 직관적으로 변경.
  - 제품명과 제조사 표기에 원문(한자, 영어 등)을 병기하여 정확성 확인 용이하게 개선.
  - **제조사 원문 추출**: Gemini 프롬프트를 수정하여 `exporterOriginal`(한자/현지어 제조사명)을 별도로 추출하도록 기능 추가.

### 4. 배포 환경 수정
- **증상**: 로컬(`macOS arm64`)에서 배포 시 `workerd` 아키텍처 불일치로 배포 실패.
- **해결**: `node_modules` 재생성 및 의존성 재설치를 통해 아키텍처 불일치 해결.

### 5. 데이터베이스 보안 경고 해결
- **Function Search Path**: `public.hybrid_search_products` 함수에 `SET search_path = public, extensions;`를 추가하여 보안 취약점 해결.
- **Extension Namespace**: `vector` 확장을 `public`에서 `extensions` 스키마로 이동하여 네임스페이스 오염 방지.
- **RLS Policy**: `search_logs` 테이블의 불필요한 퍼블릭 `INSERT` 정책을 삭제하고 관리자 권한 접근으로 강화.


## 2026-02-20 (검색 정확도 개선)

### 1. 카테고리 필터 범위 확장
- **증상**: 일본 소주(焼酎) 등 `Spirits` 카테고리 제품을 사진으로 검색 시 "찾을 수 없음"으로 나타남.
- **원인**: `detectProductType()`이 사케/소주를 모두 "Sake"로 분류하나, DB에서 `Sake` 필터는 `Spirits` 카테고리를 제외함.
- **해결**: `database/migration_wine_support.sql` — Sake 검색 시 Wine/Etc-Wine을 제외한 모든 카테고리(Spirits, Etc-Spirits, Other 등)가 검색 대상에 포함되도록 SQL RPC 수정.

### 2. 라벨 정보 추출 프롬프트 개선
- **증상**: 한자 라벨이 있을 때 한국식 한자 음독으로 읽어 검색 텍스트 품질 저하 (예: 克 → 극 대신 카츠로 읽어야 함).
- **해결**: `gemini.ts` — 두 가지 규칙 추가:
  - **영문 표기 우선 원칙**: 라벨에 영어가 직접 인쇄된 경우 AI 변환 없이 그대로 사용.
  - **한자 읽기 원칙**: 일본 주류 한자는 일본어 발음으로 읽도록 명시. 단 송죽매처럼 한국에서 관용적으로 굳어진 이름은 예외 허용.

### 3. Sake/Spirits 제조사(Exporter) 기반 우선순위 부여
- **증상**: DB에 "KINPO FACTORY HIGASHI SHUZO"로 등록된 제조사를 봇이 "Higashi Shuzo"로 추출했을 때 후보 우선순위에 반영되지 않음.
- **해결**: `search.ts` — `prioritizeSakeByMetadata()` 함수에 exporter 매칭 로직 추가:
  - 완전 일치(100점), 부분 문자열 포함(80점), 제품명 내 포함(60점), 단어 단위 매칭(20점/단어) 방식으로 가중치 부여.
  - 기존 숫자 매칭(50점) 로직과 통합하여 복합 점수로 후보 순위 결정.
### 4. 다중 사진 처리 - Cloudflare Queues 도입
- **증상**: 사진을 2장 이상 동시에 보내면 첫 번째 사진만 처리되고 나머지는 응답 없음.
- **원인**: 동시 Gemini API 호출로 Rate Limit(429) 발생.
- **해결**:
  - `backend/src/handlers/queueConsumer.ts` (신규): Queue consumer 핸들러. 사진을 1장씩 순차적으로 처리하며, rate limit 에러는 자동 재시도, 그 외 에러는 사용자에게 에러 메시지 발송 후 ACK.
  - `wrangler.toml`: `photo-search-queue` producer/consumer 바인딩 추가 (`max_batch_size: 1`, `max_retries: 3`, DLQ 설정).
  - `src/types/index.ts`: `PhotoQueueMessage` 타입 및 `Env.PHOTO_QUEUE` 추가.
  - `src/handlers/telegram.ts`: 사진 수신 시 직접 처리 대신 큐에 enqueue.
  - `src/index.ts`: `queue` 핸들러 export 추가.
  - **효과**: 30장 이상 동시에 보내도 모두 순차적으로 처리됨.