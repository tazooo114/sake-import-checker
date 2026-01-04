# 구현 계획서 (Implementation Plan)

> **Current Status**: Completed (Maintenance Mode)
>
> **Recent Updates:**
> 1. **Feature**: Added **Wine & Etc-Wine Support** (Polymorphic Extraction & Search Logic)
> 2. **Refactoring**: `tridge_data_manager` CLI/GUI logic shared via `data_manager.py`
> 3. **Performance**: Backend upload uses `TRUNCATE` RPC
> 4. **Optimization**: Triple Search skips verification for high-confidence results
> 5. **Environment**: Gemini Pay-as-you-go enabled (Queue service removed)
> 6. **Fix**: Smart Update timeout issue resolved (2026-01-14)
>    - Added auto-retry with exponential backoff (5 attempts, 2s→32s)
>    - Added upload stop button
>    - Optimized batch settings (BATCH_SIZE=50, MAX_CONCURRENT=3)
>    - Created PostgreSQL RPC function `bulk_update_sake_imports`
>    - Created COALESCE-based composite index for 4-field matching

---

## Phase 1: 기반 구축 (2시간)

### Step 1: 프로젝트 초기화
```bash
# 디렉토리 구조 생성
# package.json, wrangler.toml 설정
# TypeScript 설정
# .env.example 작성
# README.md 초안
```
- [x] 프로젝트 디렉토리 구조 생성
- [x] package.json 설정
- [x] tsconfig.json 설정
- [x] wrangler.toml 설정
- [x] .env.example 작성

### Step 2: Supabase 설정
```sql
-- database/schema.sql 작성
-- pgvector extension 활성화
-- sake_imports 테이블 생성
-- 인덱스 생성
```
- [x] Supabase 프로젝트 생성
- [x] pgvector extension 활성화
- [x] 테이블 스키마 작성
- [x] RPC 함수 작성

### Step 3: Cloudflare Workers 기본 구조
```typescript
// src/index.ts: 라우팅 설정
// src/handlers/health.ts: 헬스체크
// wrangler.toml: Secrets 설정
```
- [x] Hono 프레임워크 설정
- [x] 기본 라우팅 구현
- [x] Health check 엔드포인트
- [x] 로컬 개발 환경 구축

---

## Phase 2: AI 통합 (3시간)

### Step 4: Gemini Vision 통합
```typescript
// src/services/gemini.ts

async function extractLabelInfo(imageUrl: string) {
  // 프롬프트: 브랜드(한/영/일), 숫자, 용량, 제조사(영문) 추출
  // JSON 형식 응답 파싱
  // 에러 처리 (API 실패, 타임아웃, 재시도)
  return {
    brand: string,
    brandKorean: string,
    brandEnglish: string,
    exporterEnglish: string,
    numbers: string[],
    volume: string,
    rawText: string
  };
}
```
- [x] Gemini API 클라이언트 설정
- [x] Vision 분석 함수 구현 (2.5 Flash)
- [x] 프롬프트 최적화 (Triple Search: Exporter 포함)
- [x] 에러 핸들링 및 Retry 로직 구현

### Step 5: Gemini Embedding 통합
```typescript
async function getEmbedding(text: string) {
  // text-embedding-004 모델 사용
  // 768차원 벡터 반환
  // 배치 처리 지원 (Smart Upsert)
  return number[768];
}
```
- [x] Embedding API 연동 (REST)
- [x] 배치 처리 구현 (Smart Upsert)
- [ ] 캐싱 전략 (선택사항)

---

## Phase 3: 검색 시스템 (4시간)

### Step 6: 3단계 하이브리드 검색
```typescript
// src/services/search.ts

async function searchProduct(imageUrl: string) {
  // 1단계: Gemini Vision으로 정보 추출
  const extracted = await extractLabelInfo(imageUrl);
  
  // 2단계: 벡터 검색 (상위 10개)
  const embedding = await getEmbedding(extracted.rawText);
  const candidates = await vectorSearch(embedding, 10);
  
  // 3단계: 메타데이터 필터링
  const filtered = filterByMetadata(
    candidates, 
    extracted.numbers, 
    extracted.volume
  );
  
  // 4단계: Gemini 최종 검증
  const verified = await geminiVerify(
    imageUrl, 
    filtered.slice(0, 3)
  );
  
  return verified;
}
```
- [x] 검색 파이프라인 구현
- [x] 메타데이터 필터링 로직
- [x] AI 검증 로직

### Step 7: pgvector 검색 구현
```typescript
// src/services/database.ts

async function vectorSearch(
  embedding: number[], 
  limit: number
) {
  const { data } = await supabase.rpc('search_products', {
    query_embedding: embedding,
    match_count: limit,
    similarity_threshold: 0.5
  });
  
  return data;
}
```
- [x] Supabase RPC 함수 작성
- [x] 벡터 검색 클라이언트 구현
- [x] 유사도 임계값 튜닝

---

## Phase 4: Telegram Bot (3시간)

### Step 8: Telegram Webhook
```typescript
// src/handlers/telegram.ts

async function handleWebhook(request: Request) {
  const update = await request.json();
  
  if (update.message?.photo) {
    await handlePhoto(update.message);
  } else {
    await sendMessage(
      update.message.chat.id,
      "사진을 보내주세요"
    );
  }
  
  return new Response('OK');
}

async function handlePhoto(message: TelegramMessage) {
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const photo = message.photo[message.photo.length - 1];
  
  try {
    // 사진 URL 가져오기
    const fileUrl = await getFileUrl(photo.file_id);
    
    // 검색 실행 (10-15초 소요)
    const result = await searchProduct(fileUrl);
    
    // Reply로 결과 전송
    await sendMessage(
      chatId,
      formatResult(result),
      { reply_to_message_id: messageId }
    );
    
  } catch (error) {
    await sendMessage(
      chatId,
      "일시적 오류가 발생했습니다. 다시 시도해주세요.",
      { reply_to_message_id: messageId }
    );
  }
}
```
- [x] Webhook 핸들러 구현
- [x] 사진 메시지 처리
- [x] 결과 포맷팅
- [x] 에러 응답 처리

---

## Phase 5: Rate Limit & Queue (2시간)

### Step 9: Queue 시스템
```typescript
// src/services/queue.ts

class RequestQueue {
  private queue: Task[] = [];
  private processing = 0;
  private readonly MAX_CONCURRENT = 5;
  private readonly RATE_LIMIT = 15; // 분당 15개
  
  async add(task: Task) {
    this.queue.push(task);
    await this.process();
  }
  
  private async process() {
    if (this.processing >= this.MAX_CONCURRENT) {
      return;
    }
    
    if (this.shouldWait()) {
      await this.sendWaitMessage(task);
      await this.wait(30000); // 30초 대기
    }
    
    this.processing++;
    await this.execute(task);
    this.processing--;
    
    if (this.queue.length > 0) {
      await this.process();
    }
  }
}
```
- [x] Queue 클래스 구현 (Removed: Pay-as-you-go 전환으로 불필요)
- [x] Rate limit 로직 (Removed)
- [x] 대기 메시지 전송 (Removed)

---

## Phase 6: 관리자 페이지 (3시간)

### Step 10: Excel 업로드 UI
```html
<!-- admin/index.html -->
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>
</head>
<body>
  <div id="auth" class="hidden">
    <input type="password" id="password" />
    <button onclick="login()">로그인</button>
  </div>
  
  <div id="upload" class="hidden">
    <div id="dropzone">
      Excel 파일을 드래그하거나 클릭하세요
    </div>
    
    <div id="progress" class="hidden">
      <div class="progress-bar"></div>
      <span id="progress-text">0/0 (0%)</span>
    </div>
    
    <div id="stats">
      <p>총 레코드: <span id="total-records">0</span></p>
      <p>마지막 업데이트: <span id="last-update">-</span></p>
    </div>
  </div>
</body>
</html>
```
- [x] HTML 구조 작성
- [x] Tailwind 스타일링
- [x] 드래그앤드롭 구현

### Step 11: Excel 처리 로직
```javascript
// admin/js/upload.js

async function handleExcelUpload(file) {
  // 1. Excel 파싱
  const workbook = XLSX.read(await file.arrayBuffer());
  const sheet = workbook.Sheets['제품별_합산'];
  const data = XLSX.utils.sheet_to_json(sheet);
  
  // 2. 검증
  if (!validateColumns(data[0])) {
    alert('잘못된 파일 형식입니다');
    return;
  }
  
  // 3. 업로드 시작
  const sessionId = Date.now();
  await fetch('/admin/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, data })
  });
  
  // 4. 진행률 polling
  pollProgress(sessionId);
}

function pollProgress(sessionId) {
  const interval = setInterval(async () => {
    const res = await fetch(`/admin/progress/${sessionId}`);
    const { current, total, status } = await res.json();
    
    updateProgressBar(current, total);
    
    if (status === 'complete') {
      clearInterval(interval);
      showSuccess();
    }
  }, 1000);
}
```
- [x] Excel 파싱 구현
- [x] 데이터 검증
- [x] 청크 업로드 및 진행률 표시

---

## Phase 7: Excel 처리 백엔드 (3시간)

### Step 12: 배치 임베딩
```typescript
// src/handlers/admin.ts

async function handleUpload(request: Request) {
  const { sessionId, data } = await request.json();
  
  // 기존 데이터 삭제
  await supabase.rpc('truncate_sake_imports'); // Optimized: DELETE보다 훨씬 빠름
  
  // 배치 처리 (50개씩)
  const BATCH_SIZE = 50;
  let processed = 0;
  
  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    
    // 병렬 임베딩 (5개 동시)
    const embeddings = await Promise.all(
      batch.map(row => 
        getEmbedding(row['Reported Product Name'])
      )
    );
    
    // DB 삽입
    const rows = batch.map((row, idx) => ({
      reported_product_name: row['Reported Product Name'],
      category: row['Category'],
      exporter: row['Exporter'],
      origin_country: row['Origin Country'],
      raw_importer_name: row['Raw Importer Name'],
      value: row['Value'],
      volume: row['Volume'],
      unit_price: row['Unit Price'],
      name_embedding: embeddings[idx]
    }));
    
    await supabase.from('sake_imports').insert(rows);
    
    // 진행률 업데이트
    processed += batch.length;
    await updateProgress(sessionId, processed, data.length);
  }
  
  return new Response('Complete');
}
```
- [x] 배치 처리 로직 (Smart Upsert)
- [x] 병렬 임베딩 생성
- [x] 진행률 업데이트 (UI 피드백)

---

## Phase 8: 테스트 & 배포 (3시간)

### Step 13: 단위 테스트
```typescript
// 주요 함수 테스트
describe('Search Service', () => {
  test('벡터 검색', async () => {
    const embedding = await getEmbedding('닷사이 준마이');
    const results = await vectorSearch(embedding, 10);
    expect(results.length).toBeLessThanOrEqual(10);
  });
  
  test('메타데이터 필터링', () => {
    const candidates = [...]; // 테스트 데이터
    const filtered = filterByMetadata(
      candidates, 
      ['39'], 
      '720ml'
    );
    expect(filtered[0]).toContain('39');
  });
});
```

### Step 14: 통합 테스트
```typescript
// E2E 테스트
test('전체 검색 플로우', async () => {
  const testImage = 'https://example.com/dassai39.jpg';
  const result = await searchProduct(testImage);
  
  expect(result.confidence).toBeGreaterThan(70);
  expect(result.product.reported_product_name).toContain('닷사이');
});
```

### Step 15: 배포
```bash
# Supabase 설정
supabase link --project-ref YOUR_PROJECT
supabase db push

# Cloudflare Workers 배포
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put GEMINI_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_KEY
wrangler deploy

# Cloudflare Pages 배포
cd admin
wrangler pages deploy

# Telegram Webhook 설정
curl -X POST https://api.telegram.org/bot<TOKEN>/setWebhook \
  -d "url=https://your-worker.workers.dev/telegram-webhook"
```
- [x] 단위 테스트 작성
- [x] 통합 테스트 작성
- [x] Supabase 배포
- [x] Cloudflare Workers 배포
- [x] Cloudflare Pages 배포
- [x] Telegram Webhook 설정

---

## 배포 후 체크리스트

### Telegram Bot 생성
- [ ] @BotFather와 대화
- [ ] /newbot 명령어
- [ ] 봇 이름 설정
- [ ] 토큰 받기
- [ ] `wrangler secret put TELEGRAM_BOT_TOKEN`

### Gemini API 키
- [ ] Google AI Studio 접속
- [ ] API 키 생성
- [ ] `wrangler secret put GEMINI_API_KEY`

### Supabase 연결
- [ ] Supabase 프로젝트 생성
- [ ] Settings > API에서 URL/KEY 복사
- [ ] `wrangler secret put SUPABASE_URL`
- [ ] `wrangler secret put SUPABASE_KEY`
- [ ] SQL Editor에서 schema.sql 실행

---

## 모니터링 & 유지보수

### 로깅
```typescript
// Cloudflare Workers 로그
console.log('[SEARCH]', { userId, imageUrl, confidence });
console.error('[ERROR]', { error, context });
```

### 알림
```typescript
// 관리자 Telegram 알림
async function notifyAdmin(message: string) {
  await sendMessage(ADMIN_CHAT_ID, `⚠️ ${message}`);
}
```

### 메트릭
- 일일 조회 수
- 평균 응답 시간
- 검색 성공률 (발견 vs 미발견)
- Gemini API 사용량
- 에러 발생 빈도
