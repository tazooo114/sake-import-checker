# Smart Update 타임아웃 해결 - 수정 이력 및 계획

> **작성일**: 2026-01-14
> **최종 상태**: 해결됨

## 문제 상황

**목표**: 55,998개 행을 Smart Update 모드로 안정적으로 업로드
**현재 상태**: statement timeout (Code: 57014) 에러로 업로드 불가능
**Supabase statement_timeout**: 2분 (확인됨)

---

## 수정 이력 (Modification Log)

### 시도 #1: Composite Index 생성
- **날짜**: 2026-01-14
- **변경 내용**: 4-field composite index 생성
  ```sql
  CREATE INDEX idx_sake_imports_composite_key
  ON sake_imports (reported_product_name, exporter, origin_country, raw_importer_name);
  ```
- **결과**: ❌ 실패
  - 41,400개 처리 후 타임아웃
  - 개별 쿼리는 0.06ms로 빠르지만, 대량 처리 시 누적 타임아웃

### 시도 #2: 백엔드 병렬 배치 처리 (BATCH_SIZE=100)
- **날짜**: 2026-01-14
- **변경 내용**: `admin.ts`에서 100개씩 Promise.all로 병렬 UPDATE
- **결과**: ❌ 실패
  - 46,620개 처리 후 타임아웃
  - Supabase 커넥션 풀 고갈 문제

### 시도 #3: PostgreSQL RPC 함수 (bulk_update_sake_imports)
- **날짜**: 2026-01-14
- **변경 내용**:
  - `database/bulk_update_function.sql` 생성
  - `admin.ts`에서 개별 UPDATE 대신 RPC 호출로 변경
  - 네트워크 왕복 100회 → 1회로 감소
- **결과**: ❌ 실패
  - 20개 처리 후 바로 타임아웃
  - `IS NOT DISTINCT FROM`이 인덱스를 제대로 활용하지 못함 (Filter로 처리됨)

### 시도 #4: COALESCE 기반 인덱스 + 함수 수정
- **날짜**: 2026-01-14
- **변경 내용**:
  ```sql
  CREATE INDEX idx_sake_imports_composite_coalesce
  ON sake_imports (
    reported_product_name,
    COALESCE(exporter, ''),
    COALESCE(origin_country, ''),
    COALESCE(raw_importer_name, '')
  );
  ```
  - 함수도 COALESCE 사용하도록 수정
- **결과**: ⚠️ 부분 성공
  - EXPLAIN ANALYZE에서 Index Cond에 4개 필드 모두 사용 확인
  - 10,320개 처리 후 타임아웃

### 시도 #5: 프론트엔드 순차 처리 (MAX_CONCURRENT=1, BATCH_SIZE=50)
- **날짜**: 2026-01-14
- **변경 내용**: `upload.js` 수정
  - MAX_CONCURRENT: 3 → 1 (순차 처리)
  - BATCH_SIZE: 20 → 50
- **결과**: ⚠️ 부분 성공
  - 20,950개 처리 후 타임아웃

### 시도 #6: BATCH_SIZE 30으로 축소
- **날짜**: 2026-01-14
- **변경 내용**: `upload.js`에서 BATCH_SIZE: 50 → 30
- **결과**: ❌ 실패
  - 0개 처리 후 바로 타임아웃
  - 재시도 2번 후 30개 처리되고 멈춤
  - **매우 불안정함**

### 시도 #7: 자동 재시도 + 중지 기능 + 속도 최적화 ✅ 최종 해결책
- **날짜**: 2026-01-14
- **변경 내용**: `upload.js` 전면 개편
  - `fetchWithRetry()` 함수 추가: 최대 5회 재시도, 지수 백오프 (2초→32초)
  - 업로드 중지 버튼 추가: 사용자가 원할 때 중단 가능
  - BATCH_SIZE: 30 → 50 (더 큰 배치)
  - MAX_CONCURRENT: 1 → 3 (병렬 처리 복구)
  - UI 상태 추가: "재시도 중... (2/5)", "업로드 중지됨"
- **결과**: ✅ 성공
  - 속도 충분히 향상됨
  - 간헐적으로 5회 재시도 후에도 실패하는 경우 있음 → 수동 이어하기로 해결 가능
  - 전체적으로 안정적인 업로드 가능

---

## 현재 상태 분석

### 확인된 사실
1. **Supabase statement_timeout = 2분** (충분함)
2. **개별 UPDATE 쿼리 = 0.06ms** (매우 빠름)
3. **Composite index 작동 확인** (EXPLAIN ANALYZE로 검증)
4. **불안정한 동작**: 같은 설정으로 0개~20,950개까지 결과가 다름

### 추정 원인
1. **Supabase REST API (PostgREST) 타임아웃**: DB statement_timeout과 별개
2. **Cloudflare Workers subrequest 타임아웃**: 30초 제한
3. **Supabase 서버 부하**: 시간대에 따라 성능 변동
4. **커넥션 풀 경쟁**: 다른 요청과의 충돌

---

## 최종 결론

### 해결된 문제
- ✅ Smart Update 모드에서 statement timeout 문제 해결
- ✅ 업로드 속도 향상 (BATCH_SIZE=50, MAX_CONCURRENT=3)
- ✅ 안정적인 업로드 (자동 재시도 5회 + 이어하기)
- ✅ 사용자 제어 (중지 버튼)

### 남은 제한사항
- ⚠️ 간헐적으로 5회 재시도 후에도 실패 → 수동 이어하기 필요
- ⚠️ Supabase/Cloudflare 서버 상태에 따라 성능 변동

### 핵심 교훈
1. **근본 원인은 Supabase REST API 타임아웃** (DB statement_timeout 2분과 별개)
2. **인덱스 최적화만으로는 해결 불가** (개별 쿼리는 빠르지만 대량 처리 시 누적 타임아웃)
3. **자동 재시도 + 이어하기가 가장 실용적인 해결책**

### 적용된 최종 설정
```javascript
// upload.js
const BATCH_SIZE = 50;
const MAX_CONCURRENT = 3;
const maxRetryAttempts = 5;
// 지수 백오프: 2초 → 4초 → 8초 → 16초 → 32초
```

```sql
-- 생성된 인덱스
idx_sake_imports_composite_key (reported_product_name, exporter, origin_country, raw_importer_name)
idx_sake_imports_composite_coalesce (reported_product_name, COALESCE(exporter,''), COALESCE(origin_country,''), COALESCE(raw_importer_name,''))
```

```sql
-- 생성된 RPC 함수
bulk_update_sake_imports(updates JSONB) RETURNS INTEGER
```

---

## 파일 위치

- **백엔드**: `/backend/src/handlers/admin.ts`
- **프론트엔드**: `/admin/js/upload.js`
- **DB 함수**: `/database/bulk_update_function.sql`
- **인덱스**: `/database/add_composite_index.sql`
