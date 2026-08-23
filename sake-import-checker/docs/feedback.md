# 코드 리뷰 정리 (검증본)

- **작성일**: 2026-08-13
- **개정**: 2026-08-21 — 1차 개선 라운드 완료. 8개 항목을 배포·실측 검증했고, 그 과정에서 나온 발견으로 원래 진단 두 개(1.6의 제안, 2.7의 추정)를 정정했습니다. 9장에 라운드 요약이 있습니다.
- **대상**: `sake-import-checker` (backend, admin, database, docs)
- **성격**: 외부 리뷰 초안을 실제 코드와 대조해 검증하고, 틀린 항목을 정정하고, 리뷰에서 빠졌던 항목을 추가해 재정리한 문서
- **표기**: **[확인]** 코드로 확인됨 / **[정정]** 초안과 사실이 다름 / **[추가]** 초안에 없던 항목 / **[미확인]** 실 DB 상태를 봐야 확정 가능

---

## 0. 총평

설계 방향(큐 기반 비동기 처리, 타입별 프롬프트 분기, Smart Update, 재시도·이어하기 UX)은 개인 프로젝트 기준으로 잘 잡혀 있고, 문서화 수준은 특히 좋습니다. 실질적으로 손댈 값어치가 있는 곳은 세 군데입니다.

1. **검색 경로의 조용한 오작동** — 추출 실패 시 에러 문자열이 그대로 검색어가 되는 경로 (아래 1.1) → ✅ 2026-08-21 해결
2. **API 비용 누수** — thinking 토큰 + 사진 1장당 Vision 호출 3~12회 (아래 2장) → ✅ thinking 제거 + `rawText` 상한으로 사진당 비용 절반 이하. 호출 수 통합(3-d)은 미착수
3. **DB/저장소 드리프트** — 저장소 SQL과 문서·실 DB가 서로 어긋나 있음 (아래 3장) → ❌ **미착수. 남은 것 중 가장 큰 덩어리이며 다음 라운드의 1순위**

---

## 1. 즉시 고칠 것 (동작 오류)

### 1.1 [추가 · ✅ 해결 2026-08-21] 추출 실패 시 에러 문자열이 검색어로 임베딩됨 — 실질 버그

> **해결됨.** `createEmptyExtraction`이 진단 문자열을 더 이상 `rawText`에 싣지 않고(항상 `''`), `errorType`을 `RATE_LIMIT | EXTRACTION_FAILED | PARSE_FAILED`로 확장해 실패 원인을 표기합니다. 가드는 `search.ts`의 `isExtractionUsable()`로 분리했고 회귀 테스트 6건을 붙였습니다. 진단 정보는 호출부 로그로 보존됩니다. 아래는 원래 진단 내용입니다.

`extractLabelInfo`가 실패하면 `createEmptyExtraction(String(error), ...)`을 호출하고, 여기서 `rawText`에 **에러 메시지 문자열**이 들어갑니다 (`gemini.ts:226`, `gemini.ts:244`).

```ts
rawText: isRateLimitError ? '' : rawText,   // rawText === "Error: Timeout after 20000ms"
```

`search.ts:104`의 가드는 `!rawText && !brand`일 때만 막으므로, `rawText`가 에러 문자열로 채워진 상태는 **가드를 통과**합니다. 그 결과 `"Error: Timeout after 20000ms"`를 임베딩해 벡터 검색을 돌리고, 임계값 0.5를 넘는 아무 제품이나 후보로 올라옵니다. 유사도가 낮으니 대부분 "찾을 수 없습니다"로 끝나겠지만, **잘못된 제품을 정상 결과처럼 반환할 여지**가 있고 불필요한 임베딩·검색 비용도 발생합니다.

- 고침: rate limit이 아닌 실패도 `rawText`를 `''`로 두고 `errorType`을 별도로 표기하거나, `search.ts`에서 `extracted.confidence === 0`이면 즉시 실패 처리.

### 1.2 [확인] `verifyMatch`에 총 수입량(kg)이 "용량"처럼 들어감

`gemini.ts:335`:

```ts
`${i + 1}. ${c.reported_product_name} (${c.volume || '용량 미상'})`
```

여기서 `c.volume`은 병 용량이 아니라 **총 수입 규모(kg)** 입니다 (`formatter.ts:51` → `총 수입규모: ${product.volume.toLocaleString()}kg`). 즉 Gemini에게 `닷사이 23 (12000)`처럼 보여주고 있어 판단을 흐립니다.

- 고침: 해당 값을 빼거나 `(수입량 12,000kg)`으로 라벨을 명시.

### 1.3 [확인] 배치 임베딩 실패가 빈 배열로 흘러감

`gemini.ts:315-317`이 `result.embeddings` 부재 시 `texts.map(() => [])`를 반환합니다. 이 빈 배열이 `admin.ts:255`의 `name_embedding`으로 들어가면 `halfvec(768)` 타입 오류로 청크가 실패합니다. 그 시점엔 같은 청크의 bulk UPDATE는 이미 커밋된 뒤라 재시도 시 중복 작업이 됩니다(멱등이라 데이터가 깨지진 않음).

- 고침: 빈 배열 대신 `throw`. 그러면 `retryWithBackoff`(`admin.ts:239`)가 정상 동작합니다.

### 1.4 [확인 · ✅ 해결 2026-08-21] 숫자 매칭 오탐

`search.ts:374` — `numbers.some(num => productName.includes(num))`. `"23"`은 `"2023 빈티지"`에, `"720"`은 무관한 제품명에도 걸려 50점이 부당하게 붙습니다. 와인 쪽 vintage 매칭(`search.ts:315`)도 같은 성질입니다.

**실측으로 확인된 실제 심각도 (2026-08-21)** — 초안이 상정한 것보다 훨씬 나쁩니다. 라벨 1장에서 추출된 `numbers`가 이랬습니다.

```json
["25","900","1","37","1","099","268","2020","251714"]
```

도수(25), 용량(900), 주소 번지(1, 37), 전화번호 조각(099, 268), 연도(2020), 관리번호(251714)가 전부 들어왔습니다. 여기서 **`"1"`이 치명적입니다** — `productName.includes("1")`은 이름에 1이 들어간 거의 모든 제품에 50점을 붙이므로, 메타데이터 재정렬이 사실상 무작위가 됩니다. 해당 케이스는 `verifyMatch`가 걸러줘서 정답이 나왔지만, 재정렬 단계는 제 역할을 못 했습니다.

> **해결됨.** 프롬프트에서 `numbers` 범위를 좁히고(도수·용량·전화번호·주소·관리번호 제외), 코드에서 `meaningfulNumbers()`가 한 자리 숫자와 용량성 숫자를 버리며, `hasNumberMatch()`가 앞뒤에 숫자가 없을 때만 일치로 칩니다. 와인 vintage에도 동일 적용. 회귀 테스트 9건 추가. 아래는 원래 진단입니다.

- 고침: 단어 경계 검사(`\b23\b` 수준) 또는 용량성 숫자(720/1800/750) 제외 목록.
- **추가 고침**: 애초에 프롬프트에서 `numbers`의 범위를 좁힐 것. "제품 등급·숙성도를 나타내는 숫자만. 도수·용량·전화번호·주소·관리번호는 제외"를 명시하면 근본에서 해결됩니다. 2자리 미만 숫자는 코드에서 버리는 가드도 같이 넣을 것.

### 1.5 [확인] 언어 불일치로 2단계 가산점이 조용히 무력화

Gemini는 `exporterEnglish`(영문)를 뽑는데 DB `exporter`가 한글/일문 표기면 `includes()`가 절대 매칭되지 않아 점수 0 → 벡터 순서 그대로 폴백됩니다 (`search.ts:346-370`). 오답을 만들진 않지만 메타데이터 재정렬이 사실상 꺼진 상태가 됩니다.

- 확인 방법: 엑셀 `Exporter` 컬럼의 표기 체계를 샘플링. 한글/일문이면 `exporterOriginal`도 함께 매칭에 쓰도록 확장.

> **부분 해결 (2026-08-21).** 근본 원인(표기 체계 불일치)은 그대로지만, 재정렬에 **브랜드명 매칭을 추가**해 exporter가 0점이어도 정답이 점수를 받도록 했습니다. DB 제품명이 `후쿠코마치 쥰마이 카라구치 (FUKUKOMACHI JUNMAI KARAKUCHI)` 형태로 한글·영문을 모두 담고 있어 양쪽 표기가 매칭됩니다. 기존 재정렬은 브랜드를 아예 보지 않고 exporter와 numbers만 봤는데, 이것이 재정렬 오작동의 근본 원인이었습니다. 실측 3건에서 정답 후보가 모두 브랜드 매칭으로 +100을 받아 1위를 유지했습니다.

### 1.6 [확인] High Confidence Skip의 미묘한 위험

> **위험 감소 (2026-08-21).** 재정렬이 보조 신호만으로 후보를 끌어올리지 못하게 고친 뒤, 실측 3건에서 재정렬이 벡터 1위를 바꾸지 않았습니다. 다만 판정 구조 자체는 그대로이므로 아래 서술은 유효합니다. 실측에서 福小町이 gap 0.013(2위 0.8185)으로 검증을 건너뛴 사례가 있어, 좁은 gap에서의 스킵은 여전히 재검토 대상입니다.

`search.ts:155-176`은 **메타데이터 재정렬 후**의 1위 유사도로 검증 스킵을 판정합니다. 재정렬로 올라온 후보는 벡터 1위가 아닐 수 있어, "유사도 0.82 + 가산점"이 겹친 오답이 검증 없이 확정될 수 있습니다. 빈도는 낮을 것으로 보이며, 스킵 판정을 재정렬 이전의 벡터 1위 기준으로 바꾸면 해소됩니다.

---

## 2. API 비용

### 2.0 [추가] 비용 구조 — output의 대부분은 눈에 보이지 않는다

`gemini-2.5-flash`의 output 단가는 input의 8배 안팎입니다(정확한 수치는 https://ai.google.dev/pricing 에서 확인). 그런데 호출당 실제 output을 뜯어보면 **눈에 보이는 JSON은 비용의 10~20%도 되지 않습니다**.

| 출처 | 대략 토큰 | 비고 |
| --- | --- | --- |
| thinking 토큰 | 500~2000 | 응답에 보이지 않는데 output 단가로 과금 |
| `rawText` | 200~800 | "라벨의 모든 텍스트" — CJK라 토큰 효율이 나쁨 |
| 나머지 8~11개 필드 | 80~150 | 키 이름 + 값 |
| ` ```json ` 펜스·서두 | 10~30 | 정규식으로 걷어내는 그 부분 |

따라서 프롬프트를 줄이거나 필드명을 짧게 바꾸는 식의 최적화는 thinking을 끄기 전에는 의미가 없습니다. 순서가 중요합니다: **thinking → rawText → 호출 수 → 출력 형식**.

### 2.1 [확인] thinking 토큰 — 단일 항목으로 가장 큰 레버

`gemini-2.5-flash`(`gemini.ts:5`)는 thinking이 기본 활성화라, 호출마다 보이지 않는 thinking 토큰이 **output 단가**로 과금됩니다. 라벨 추출·후보 선택 같은 작업엔 사실상 불필요합니다.

**모델 다운그레이드는 검토 후 기각(2026-08-21).** `gemini-2.0-flash`나 `gemini-2.5-flash-lite`로 PRIMARY를 내리면 thinking이 없어 같은 효과를 한 줄로 얻을 수 있지만, 라벨 OCR 정확도(특히 한자 읽기·영문 표기 우선 원칙)를 우선해 **2.5-flash를 유지**하기로 결정했습니다. 그 결과 아래의 REST 전환은 선택이 아니라 **필수 경로**가 됩니다.

- 고침: `thinkingConfig: { thinkingBudget: 0 }`. 단 현재 쓰는 `@google/generative-ai@^0.21.0` (`backend/package.json`)은 레거시 SDK라 `thinkingConfig`를 지원하지 않을 가능성이 큽니다. 임베딩에서 이미 쓰고 있는 **REST 직접 호출 패턴**(`gemini.ts:252`)을 `generateContentWithFallback`에도 적용하는 것이 가장 적은 변경으로 끝나는 방법입니다.

```ts
const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${env.GEMINI_API_KEY}`;

body: JSON.stringify({
  contents: [{ parts: [
    { text: prompt },
    { inline_data: { mime_type: mimeType, data: base64Image } },
  ]}],
  generationConfig: {
    thinkingConfig: { thinkingBudget: 0 },   // 2.5 계열에만
    responseMimeType: 'application/json',
    responseSchema: EXTRACTION_SCHEMA,
    maxOutputTokens: 800,
    temperature: 0,
  },
})
```

- `temperature: 0` — 추출 작업에 샘플링 다양성은 손해입니다.
- **폴백 모델 주의**: `FALLBACK_MODEL`은 `gemini-2.0-flash`(`gemini.ts:6`)로 thinking이 없습니다. 이 모델에 `thinkingConfig`를 보냈을 때 무시되는지 400으로 거절되는지 확인되지 않았으므로, **2.5 계열일 때만 조건부로 포함**하는 편이 안전합니다. 폴백 경로는 primary 실패 시에만 타므로 여기서 터지면 장애가 이중으로 납니다.

**적용 결과 (2026-08-21)**: `generateContentREST()`로 전환 완료. `supportsThinking()`이 2.5 계열에만 `thinkingConfig`를 붙입니다. 부수 효과로 (a) rate limit 판별이 문자열 매칭에서 `response.status === 429`로 정확해졌고, (b) 타임아웃이 `Promise.race`에서 `AbortController`로 바뀌어 버려진 요청이 실제로 취소되며, (c) `@google/generative-ai` SDK가 워커 번들에서 빠졌습니다(`src/scripts/`의 디버그 스크립트 2개만 아직 참조).

**검증 완료 (2026-08-21, 운영 배포 후 `wrangler tail` 실측)**: 사진 1장 처리 시 세 호출 모두 `thoughts: 0`. `thinkingConfig`가 v1beta REST에서 정상 동작합니다.

| 호출 | prompt | output | thoughts |
| --- | --- | --- | --- |
| `detectProductType` | 424 | 2 | 0 |
| `extractLabelInfo` | 946 | 412 | 0 |
| `verifyMatch` | 475 | 19 | 0 |
| **합계** | **1,845** | **433** | **0** |

전환 이전의 thinking 토큰 실측치가 없어 절감 배수를 정확히 계산할 수는 없지만, thinking이 꺼진 것 자체는 확정입니다.

### 2.2 [정정] 사진 1장당 Vision 호출 수 — 최대 6회가 아니라 최대 12회

경로를 그대로 세면:

| 단계 | 호출 |
| --- | --- |
| `detectProductType` (`gemini.ts:180`) | 1회, 폴백 시 2회 |
| `extractLabelInfo` | 1회, 폴백 시 2회 |
| `verifyMatch` (스킵 안 될 때) | 1회, 폴백 시 2회 |
| 위 전체가 `search.ts:43`의 재시도로 최대 ×2 | |

즉 최선 2회(스킵 시), 통상 3회, **최악 12회**입니다. `generateContentWithFallback`(`gemini.ts:19-62`)의 모델 폴백이 호출 수를 두 배로 만드는 경로가 초안에서 빠져 있었습니다.

`detectProductType`(`gemini.ts:68`)은 output이 `"Sake"` 한 단어(약 2토큰)뿐인데 **thinking 비용과 이미지 input을 풀로 냅니다**. 배보다 배꼽이 큰 전형적인 경우입니다.

- 고침: **타입 판별과 추출을 한 호출로 통합**. 통합 프롬프트에 `productType` 필드를 하나 추가하면 됩니다. 이것만으로 호출 수가 절반이 됩니다.
- 구현 시 걸림돌은 Sake/Wine 프롬프트가 분기되어 있다는 점(`getSakeExtractionPrompt` / `getWineExtractionPrompt`)입니다. 두 스키마의 합집합(wine 전용 필드는 nullable)으로 통합하고, 프롬프트에 "productType이 Wine이면 region·grapeVariety·vintage를 채우고 Sake면 비워둘 것"을 명시하면 해소됩니다.

### 2.3 [확인] 구조화 출력으로 전환

`responseMimeType: "application/json"` + `responseSchema`를 지정하면 `gemini.ts:191`, `gemini.ts:355`의 정규식 JSON 추출 실패 경로가 사라지고 output 토큰도 줄어듭니다. 절약분 자체는 호출당 20~30토큰으로 작지만, **1.1 버그의 발생 경로 하나를 원천 차단한다는 점이 더 중요합니다** — 응답이 JSON이 아니면 `jsonMatch`가 null이 되고 그대로 `createEmptyExtraction(responseText, ...)`로 흘러 에러 문자열이 검색어가 됩니다.

### 2.4 [확인 · 근거 보강] `rawText` 상한 — 비용과 정확도가 같은 방향

`rawText`는 output에서 두 번째로 큰 항목이고, 유일한 소비처는 `buildSearchText`가 검색어로 이어붙이는 것입니다(`search.ts:230`, `:239`). 여기에 문제가 둘 겹칩니다.

- **중복 과금**: `brand`, `brandKorean`, `brandEnglish`, `exporterEnglish`는 이미 `rawText`의 부분집합입니다. 같은 글자를 output으로 두 번 내보내고 있습니다.
- **임베딩 희석**: 수백 자짜리 `rawText`를 브랜드명과 함께 이어붙이면 "獺祭 純米大吟醸" 신호가 도수·주소·주의문구에 묻힙니다.

**실측 사례 (2026-08-21, 焼酎 라벨 1장)** — 추출 호출의 output 412토큰 중 대부분이 아래 `rawText`이고, 이것이 그대로 임베딩 검색어가 됐습니다.

```
原材料名 さつまいも(国産)、米麹(国産米)
鹿児島市小松原1丁目37番1号
TEL(099)268-2020
https://higashi-sz.com 東酒造 検索
PH251714
は二十歳になってから。お酒はおいしく適量を。
飲酒運転は禁じられております。焼酎は成分が析出し沈殿を生じる事が…
```

주소·전화번호·URL·관리번호·음주경고문·침전물 안내가 전부 output 토큰으로 과금되고 검색어를 오염시킵니다. 브랜드명 "克 新 無手勝流"가 여기 파묻힌 상태에서 유사도 0.794가 나온 것은 운이 좋은 편입니다.

즉 상한을 걸면 비용과 검색 정확도가 **동시에** 개선될 가능성이 높습니다. 초안의 "200자"보다 더 공격적으로 잡아도 됩니다.

```
8. rawText: 라벨의 핵심 텍스트만 100자 이내
   (브랜드·양조장·등급 표기 우선. 도수, 주소, 주의문구, 성분표시는 제외)
```

`responseSchema`를 쓴다면 해당 필드에 `maxLength`로 강제할 수도 있습니다.

### 2.5 [확인] 임베딩 비용은 무시해도 됨

56k행 전량 재생성해도 $1 미만 수준입니다. 아낄 곳은 전부 Vision 쪽입니다.

### 2.6 [추가] `maxOutputTokens` 적용 순서 — 잘못하면 1.1 버그를 유발

2.5 계열에서 `maxOutputTokens`는 **thinking 토큰을 포함해서** 셉니다. thinking을 끄지 않은 상태로 상한을 걸면 thinking이 예산을 다 소진해 `finishReason: MAX_TOKENS`와 함께 **빈 응답**이 돌아옵니다. 그러면 `jsonMatch`가 null → `createEmptyExtraction(responseText, false, ...)` → 1.1의 오작동 경로로 직행합니다.

- 규칙: **`thinkingBudget: 0`을 먼저 적용하고, 그 다음에 `maxOutputTokens`를 건다.** 순서를 지키지 않으면 비용을 아끼려다 오답 경로를 여는 결과가 됩니다.

### 2.7 [추가 · ❌ 실측으로 기각] 이미지 input 축소 — 아낄 게 거의 없음

당초 이 항목은 "thinking을 끄면 이미지 input이 지배적 비용이 된다"고 적었고, `telegram.ts:63-68`이 5MB 이하 중 가장 큰 사진을 고르므로 1280×1280이면 타일 4장 = 1000토큰 이상일 것으로 추정했습니다. **실측 결과 이 추정은 틀렸습니다.**

2026-08-21 실측에서 `detectProductType`의 prompt는 424토큰인데, 프롬프트 텍스트가 약 170토큰이므로 이미지는 **250토큰 남짓 — Gemini 최소 타일 1장 수준**입니다. Telegram이 전달하는 사진이 이미 충분히 작습니다. 해상도를 더 낮춰봐야 절감폭이 미미하고, 라벨의 작은 한자 OCR 정확도만 잃습니다. **기각.**

- `verifyMatch`도 input 쪽 항목이지만 prompt 475토큰으로 작습니다. 후보 개수 축소도 우선순위가 낮습니다.
- 결론: thinking 제거 후 남은 유일한 의미 있는 레버는 **`rawText`(2.4)** 하나입니다. output 433토큰 중 412가 추출 호출이고 그 대부분이 `rawText`입니다.

### 2.9 [추가 · ❌ 실험 후 기각] 검색어를 DB 임베딩 텍스트 구조에 맞추기

DB 쪽 임베딩 텍스트(`admin.ts:145`)는 `[krName, enName, Exporter, Origin Country]`로 만들어져 한글명·영문명·양조장만 담는 반면, 질의 쪽 `buildSearchText`는 한자 원문과 `rawText`를 함께 넣습니다. 이 비대칭을 없애면 정확도가 오를 것이라는 가설로 두 라운드를 실험했으나 **기각했습니다**.

- **와인에서 치명적이었습니다.** `DEANDE MALBEC 2023 MENDOZA` 라벨의 검색어가 `데안데 DEANDE DEANDE`로 축소되면서 품종·지역 정보를 잃었고, 정답(`디안데 멘도사 말벡`)을 못 찾고 무관한 `로센데`를 반환했습니다. legacy 방식으로는 0.8421로 정확히 찾습니다.
- **측정 자체가 성립하지 않았습니다.** 효과 크기(0.01~0.03)가 추출 비결정성(0.09)보다 작았습니다.

**핵심 발견 — Gemini 추출은 `temperature: 0`에서도 비결정적입니다.** 동일한 사진에서 `exporterEnglish`가 `Higashi Shuzo` / `Higashi Shuzo Co., Ltd.`로, `rawText`가 `福小町 秋田 木村 精米歩合55%` / `福小町 創業元和 秋田木村 精米歩合55% 吟の精25% ぎんさん75% 株式会社 木村酒造`로 갈렸습니다.

반면 **임베딩·벡터검색·재정렬 단계는 완전히 결정론적입니다** — 검색어가 같으면 유사도가 소수점 15자리까지 일치했습니다(`0.819457612928652` 2회). 따라서 검색 단계를 튜닝할 때는 **추출 JSON을 픽스처로 고정한 평가 스크립트**를 써야 하고, 사진부터 매번 돌리면 앞단 변동이 뒷단 측정을 덮어씁니다. 5.2가 필요한 이유가 이것입니다.

### 2.8 [추가] Batch API는 적용 대상이 아님

Gemini Batch API는 50% 할인이지만 최대 24시간 비동기라, 텔레그램 봇의 대화형 경로에는 쓸 수 없습니다. 검토 후 기각.

---

## 3. DB · 업로드 경로

### 3.1 [확인 · 미확인] `fix_unique_constraint.sql`은 설계와 정면 충돌

`database/fix_unique_constraint.sql`은 `reported_product_name` **단독 UNIQUE**를 겁니다. 이는 `admin.ts:175-197`의 4필드 복합키("같은 제품·다른 수입사를 별도 행으로 보존") 설계와 정면으로 충돌하며, 살아 있다면 같은 제품명의 두 번째 수입사 행 insert가 `23505`로 터집니다.

- **다만**: `SMART_UPDATE_TIMEOUT_FIX.md`에 56k행 업로드 성공 기록이 있으므로, 실 DB에는 **적용되지 않았을 가능성이 높습니다**. 확정하려면 아래를 실행:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid = 'sake_imports'::regclass;
```

- 존재하면 드랍. 존재하지 않으면 **파일 자체를 저장소에서 제거**(또는 상단에 "적용 금지" 명시) — 문서의 적용 순서에 포함돼 있어 나중에 누군가 그대로 실행할 위험이 있습니다.

### 3.2 [확인] 저장소의 `bulk_update_function.sql`이 구버전

저장소 파일은 여전히 `IS NOT DISTINCT FROM`을 씁니다(`bulk_update_function.sql:39-41`). 이건 `SMART_UPDATE_TIMEOUT_FIX.md` 시도 #3에서 "인덱스를 못 타고 Filter로 처리됨"으로 직접 실패 판정한 버전이고, 문서상 최종본(시도 #4)은 COALESCE 버전입니다. 즉 **실 DB 함수와 저장소 파일이 다릅니다**.

- 고침: 실 DB의 함수 정의를 떠서 저장소 파일을 갱신. (`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='bulk_update_sake_imports';`)

### 3.3 [확인] 업로드 락의 구조적 원인 — SELECT→분기 대신 upsert

현재 흐름은 `SELECT`(존재 판별, `admin.ts:165`) → `UPDATE`/`INSERT` 분기입니다. `upload.js:212`가 `MAX_CONCURRENT = 3`으로 청크를 병렬 전송하므로:

1. 왕복이 1회 더 든다
2. **race**: 두 청크가 같은 신규 키를 동시에 조회 → 둘 다 "없음" 판정 → 둘 다 insert
3. 겹치는 행을 서로 다른 순서로 잠그면 락 대기 → PostgREST 타임아웃

권장 해법은 upsert 일원화입니다.

```sql
CREATE UNIQUE INDEX uq_sake_imports_composite ON sake_imports
  (reported_product_name, COALESCE(exporter,''), COALESCE(origin_country,''), COALESCE(raw_importer_name,''));
```

RPC 안에서 키 순으로 정렬한 뒤 `INSERT ... ON CONFLICT DO UPDATE` 한 방으로 처리하면 왕복·race·락 순서 문제가 동시에 사라집니다. 임베딩은 "신규 키만 미리 생성"하는 현 로직을 유지하되, 충돌 시 `name_embedding = COALESCE(sake_imports.name_embedding, EXCLUDED.name_embedding)`로 기존 벡터를 보존하면 됩니다.

- 급하면 **UPDATE 성격의 청크만 `MAX_CONCURRENT=1`로 직렬화**하는 것만으로도 락은 크게 줄어듭니다 (신규 insert는 병렬 유지).
- 부수 효과: 중복 행이 생겨 있으면 `bulk_update`의 `ROW_COUNT`(`bulk_update_function.sql:43`)가 부풀려져 "업데이트 N건" 표시도 부정확해집니다.

### 3.4 [추가] 벡터 타입/인덱스 정의가 저장소 안에서 서로 모순

- `schema.sql:29` — `name_embedding halfvec(768)`, 인덱스는 `ivfflat (… halfvec_cosine_ops)`
- `migration_hnsw.sql:26` — `hnsw (name_embedding vector_cosine_ops)`

`vector_cosine_ops`는 `halfvec` 컬럼에 붙지 않습니다. 둘 다 참일 수 없으므로 실 DB는 둘 중 하나(또는 저장소에 없는 제3의 상태)입니다. 포트폴리오 문서(`ARCHITECTURE.md:693`, `:723`)가 두 서술을 모두 담고 있어 **읽는 사람이 모순을 발견할 수 있는 상태**입니다.

- 확인: `SELECT indexdef FROM pg_indexes WHERE tablename='sake_imports';` + `\d sake_imports`의 컬럼 타입. 실물에 맞춰 저장소 SQL과 문서를 정렬.

### 3.5 [추가] 실제로 호출되는 `search_products`에 `hnsw.ef_search` 설정이 없음

코드는 4인자 버전을 호출합니다(`database.ts:32-38`, `category_filter` 포함). 그 4인자 정의(`migration_wine_support.sql:20`)에는 `SET LOCAL hnsw.ef_search = 100`이 **없습니다**. 해당 설정은 3인자 버전(`migration_hnsw.sql:50`)에만 있습니다. 그런데 `ARCHITECTURE.md:600-601`은 "실제 함수는 맨 앞에서 ef_search=100을 지정한다"고 서술합니다 — 저장소 기준으로는 사실이 아닙니다.

게다가 주종 필터가 인덱스 스캔 **이후**에 걸리는 구조라, `match_count = 50` (`search.ts:126`)을 요청해도 실제로 돌아오는 후보는 그보다 적을 수 있습니다.

- 고침: 4인자 버전 맨 앞에 `SET LOCAL hnsw.ef_search = 100;` 추가(무료, 정확도 직결).
- 겸사겸사: 3인자/4인자 오버로드가 공존하면 유지보수 혼선이 크니 3인자 버전은 드랍 권장.

### 3.6 [확인 · 일부 유보] 인덱스 정리로 용량 회수

- `idx_sake_imports_name`(GIN tsvector, `schema.sql:44`) — 코드 어디에서도 전문 검색을 쓰지 않으므로 후보 1순위. **단 유보 조건**: `fix_warnings.sql:22`가 저장소에 존재하지 않는 `hybrid_search_products` 함수를 참조합니다. 실 DB에 이 함수가 있고 tsvector를 쓴다면 드랍하면 안 됩니다. 먼저 확인: `SELECT proname FROM pg_proc WHERE proname LIKE '%search%';`
- 복합 인덱스가 2개(일반 + COALESCE, `SMART_UPDATE_TIMEOUT_FIX.md:136-137`)면 실제 함수가 쓰는 쪽 하나만 남기고 드랍.
- 매 업로드마다 5만+ 행을 UPDATE하므로 dead tuple 블로트가 상당할 것입니다. `pg_stat_user_tables`의 `n_dead_tup` 확인 후 필요시 업로드 없는 시간에 `VACUUM FULL`.

### 3.7 [확인] 이력이 없는 덮어쓰기 모델 (요구사항 판단)

`value`/`volume`/`unit_price`를 매 업로드마다 덮으므로 "작년 대비 단가 추이"에 답할 수 없습니다. 추이가 소싱 판단에 필요하다면 `data_period` 컬럼 추가(복합키에 포함)가 가장 싼 확장입니다. 현재 목적(수입 여부 + 최신 가격)엔 현행도 합리적이므로 **선택 사항**입니다.

---

## 4. 사용자 경험

### 4.1 [정정] DLQ 침묵 실패 — 범위가 초안보다 좁음

초안은 "실패가 침묵으로 끝난다"고 했지만, `queueConsumer.ts:44-53`은 **비재시도성 에러에 대해 사용자에게 안내 메시지를 보냅니다**. 침묵이 되는 경로는 좁혀서:

> `429` / `timeout` / `network` 문자열을 포함한 **재시도성 에러**가 `max_retries = 3` (`wrangler.toml:50`)을 소진 → `photo-search-dlq`로 이동 → **DLQ 컨슈머 없음** → 사용자는 "분석 중..." 이후 영원히 무응답

- 고침: DLQ 컨슈머를 추가해 최소한 실패 안내를 보내기(코드 몇 줄, 무료).

### 4.2 [정정] 사진을 '파일'로 보내면 — "사진을 보내주세요"조차 안 감

초안은 안내 문구가 답장된다고 했으나, `telegram.ts:38-42`는 `message.photo` 또는 `message.text`만 처리합니다. Telegram에서 압축 없이 보내면 `message.document`로 오므로 `text`가 없어 **아무 응답도 가지 않습니다**(완전 무응답).

- 고침: `message.document`에 image mime type이면 그대로 처리하거나, 최소한 안내 발송.

### 4.3 [확인] 텍스트 검색이 없음 — 공짜로 얻는 기능

`telegram.ts:109`가 `/start` 외 모든 텍스트에 "사진을 보내주세요 📸"로 답합니다. 임베딩 + 벡터 검색 파이프라인이 이미 다 있으므로, 텍스트 입력 → `getEmbedding` → `vectorSearch`로 연결하면 **Vision 호출 0회**로 검색됩니다. 수입사 리스트 대조처럼 사진을 찍기 애매한 상황에서 실용성이 큽니다.

### 4.4 [확인] "불확실합니다"가 막다른 골목

`search.ts:195-204`는 후보를 보여주고 끝납니다. 인라인 키보드로 "1번 맞음 / 2번 맞음 / 다 아님" 버튼을 달면 사용자는 탭 한 번으로 확정 정보를 얻고, **정확도 튜닝용 정답 라벨을 공짜로 수집**하게 됩니다(아래 5.2와 직결).

### 4.5 [확인] 업로드 시 스킵된 행이 조용히 버려짐

`admin.ts:125`가 `Product Name (KR)`이 빈 행을 필터링하는데 카운트를 반환하지 않습니다. 응답에 `skipped: N`을 실어 완료 알림(`upload.js:294`)에 표시하면 데이터 유실을 인지할 수 있습니다.

### 4.6 [확인] 56k행 업로드 동안 브라우저 탭을 열어둬야 함

현재 규모에선 감수할 만합니다. 개선한다면 파싱된 JSON을 R2/Queue로 넘기고 Worker가 뒤에서 처리하는 구조(무료 티어 내 가능)가 있습니다. **우선순위 낮음.**

---

## 5. 정확도 · 관측

### 5.1 [확인] 하이브리드 검색(pg_trgm)이 가장 큰 정확도 레버

사케·와인 제품명은 고유명사라 벡터보다 문자 유사도가 더 정확한 경우가 많습니다. Postgres 내장 `pg_trgm`(무료)으로 `similarity(reported_product_name, 추출텍스트)`를 구해 벡터 결과와 RRF(순위 융합)로 합치면, `"Dassai 23"`처럼 라벨 텍스트가 정확히 읽힌 케이스의 정확도가 크게 올라갑니다. `search_products` RPC 수정만으로 가능합니다. (`fix_warnings.sql`이 참조하는 `hybrid_search_products`가 실 DB에 이미 있다면 그 구현부터 확인할 것 — 3.6 참조.)

### 5.2 [확인 · 부분 해결 2026-08-21] 측정 없이는 튜닝도 없음

> **검색 단계 평가 하네스 추가.** `POST /admin/eval`이 실측 로그에서 뜬 추출 JSON을 픽스처로 고정해두고 검색 단계(검색어 생성 → 임베딩 → 벡터검색 → 재정렬)만 돌립니다. Vision 호출이 없어 비용은 픽스처당 임베딩 1회 + DB 조회 1회입니다.
>
> 필요했던 이유: Gemini 추출이 `temperature: 0`에서도 비결정적이라(2.9 참조) 사진부터 매번 돌리면 앞단 변동(유사도 0.09 수준)이 검색 로직 변경의 효과(0.01~0.03 수준)를 덮어버립니다. 검색 단계는 결정론적이므로 추출을 고정하면 노이즈 없이 비교됩니다.
>
> **실행 경로 주의**: 평가는 HTTP 핸들러에서 바로 돌리지 않고 **큐에 넣어 컨슈머가 실행**합니다. Cloudflare Workers는 요청을 받은 엣지 위치에서 외부 호출을 내보내는데, 관리자 HTTP 요청이 도달하는 위치에서 Gemini 임베딩이 `User location is not supported`(400 FAILED_PRECONDITION)로 거절됐습니다. 같은 API 키·같은 코드인데 큐 컨슈머에서는 정상 동작하므로, 사진 검색이 매일 통과하는 그 경로를 재사용합니다. 결과는 텔레그램과 `wrangler tail` 양쪽으로 나갑니다.
>
> 픽스처 5개(정상 3 + 회귀 2)로 시작하며, `backend/src/fixtures/searchEval.ts`에 있습니다. 검색이 틀리는 사례를 만나면 그 추출 JSON을 추가하면 실패가 회귀 테스트로 남습니다. 임계값(0.82 / 0.75 / 0.15) 튜닝의 근거도 여기서 나옵니다 — 응답의 `wouldSkipVerification`과 `similarityGap`이 그 판단 재료입니다.
>
> **아직 남은 것**: `search_logs` 테이블에 실제 사용자 검색을 기록하는 부분(아래 원래 항목)과 4.4의 피드백 버튼. 평가 하네스는 회귀를 막지만, 어떤 라벨에서 틀리는지 **발견**하려면 실사용 로그가 필요합니다.


`search_logs` 테이블(`schema.sql:71`)이 만들어져만 있고 코드 어디에서도 쓰이지 않습니다. 검색마다 추출 결과·매칭 결과·확신도를 insert하고(비용 0) 4.4의 피드백 버튼과 합치면 "어떤 라벨에서 틀리는지" 데이터가 쌓여 임계값(0.82 / 0.75 / 0.15) 튜닝의 근거가 생깁니다.

### 5.3 [확인] 중복 사진 캐시

같은 라벨을 반복 조회하는 패턴이 있다면, 이미지 해시 → 결과를 Workers KV(무료 티어)에 캐싱해 Vision 호출을 통째로 절약할 수 있습니다.

---

## 6. 보안

### 6.1 [정정] 웹훅 secret 검증 — **이미 구현되어 있음**

초안은 "검증 추가 필요"로 우선순위 4위에 올렸지만, `telegram.ts:14-33`에 `X-Telegram-Bot-Api-Secret-Token` 검증이 이미 들어가 있습니다. 실패 시 401이 아니라 200으로 조용히 무시하는 처리까지 되어 있습니다.

남은 것은 **운영 환경에 secret이 실제로 설정되어 있는지**뿐입니다. 설정되지 않으면 `telegram.ts:17-23`이 경고만 찍고 **검증을 건너뜁니다**(기존 동작 보존 목적).

```bash
wrangler secret list          # TELEGRAM_WEBHOOK_SECRET 존재 확인
# 없으면: wrangler secret put TELEGRAM_WEBHOOK_SECRET  +  setWebhook에 동일 값 등록
```

### 6.2 [확인] 봇 사용자 제한

내부용 서비스이므로 허용 `chat_id` 목록으로 제한하면 할당량 도용 여지가 더 줄어듭니다(10분 작업).

### 6.3 [확인 · 낮음] 관리자 인증 비교

`admin.ts:90`, `:103`, `:310`의 `authHeader !== \`Bearer ${...}\`` 는 이론상 타이밍 공격에 취약하지만 실제 위험은 낮습니다. **우선순위 낮음.**

### 6.4 [추가 · 낮음] CORS가 모든 `*.pages.dev`를 허용

`index.ts:14`가 `.pages.dev`로 끝나는 모든 오리진을 허용합니다. 인증이 쿠키가 아니라 헤더 토큰이라 실제 위험은 낮지만, 자기 도메인만 허용하도록 좁히는 게 깔끔합니다.

---

## 7. 문서 정확성

### 7.1 [확인] README의 이미지 비교 서술이 사실과 다름

`README.md:22` — "상위 후보 제품의 **이미지**와 사용자가 보낸 사진을 AI가 최종 비교·검증" `README.md:43` — "질의 이미지와 후보 제품 **이미지**의 시각적 유사도 검증"

DB에 제품 이미지가 없습니다(`schema.sql:12-34`). `verifyMatch`는 **사진 vs 후보 제품명(텍스트)** 비교입니다. 포트폴리오 용도라면 반드시 고쳐야 할 표현입니다.

### 7.2 [추가] `ARCHITECTURE.md`의 `ef_search` 서술

`ARCHITECTURE.md:600-601`의 "실제 함수는 `SET LOCAL hnsw.ef_search = 100`을 지정한다"는 저장소 기준으로 사실이 아닙니다(3.5 참조). 코드를 고치든 문서를 고치든 한쪽을 맞춰야 합니다.

### 7.3 [추가] 저장소 SQL 전반의 드리프트

`bulk_update_function.sql`(구버전, 3.2), `fix_unique_constraint.sql`(적용하면 안 되는 파일, 3.1), `halfvec` vs `vector_cosine_ops`(3.4), 3인자/4인자 오버로드 공존(3.5). **실 DB 상태를 한 번 떠서 `database/` 전체를 실물에 맞추는 작업**을 권합니다 — 포트폴리오로 보여줄 저장소라면 이 정합성이 곧 신뢰도입니다.

---

## 8. 우선순위

| 순위 | 작업 | 효과 | 비용 | 근거 | 상태 |
| --- | --- | --- | --- | --- | --- |
| 1 | 추출 실패 시 에러 문자열 임베딩 차단 | 오답 반환 경로 제거 | $0 | 1.1 | ✅ **완료·배포 (2026-08-21)** |
| 2 | 실 DB 상태 확인 (제약·함수·인덱스 3종 쿼리) | 시한폭탄 유무 확정 | $0 | 3.1 / 3.2 / 3.4 | 미착수 |
| 3 | REST 전환 + `thinkingBudget: 0` | API 비용 대폭 절감 | $0 | 2.1 | ✅ **완료·배포·실측 검증 (2026-08-21) — `thoughts: 0` 확인** |
| 3-b | `maxOutputTokens` + `responseSchema` (3 이후) | 비용 + 1.1 경로 차단 | $0 | 2.3 / 2.6 | 미착수 |
| 3-c | `rawText` 100자 상한 | 비용 + 검색 정확도 | $0 | 2.4 | ✅ **완료·배포·실측 (output 412→118~168)** |
| 3-d | 타입판별·추출 통합 (호출 절반) | 비용 | $0 | 2.2 | 미착수 |
| 3-e | 숫자 매칭 오탐 수정 | 재정렬 정상화 | $0 | 1.4 | ✅ **완료·배포·실측 (2026-08-21)** |
| 3-f | 재정렬에 브랜드 매칭 추가 + 보조신호 게이트 | 오답 승격 차단 | $0 | 1.4 / 1.5 | ✅ **완료·배포·실측 3/3 성공** |
| 4 | `verifyMatch`의 kg 값 제거 | 검증 정확도 | $0 | 1.2 | 미착수 |
| 5 | 4인자 `search_products`에 `ef_search` 추가 | 검색 리콜 | $0 | 3.5 | 미착수 |
| 6 | upsert 전환 (또는 UPDATE 청크만 직렬화) | 락·중복·race 해결 | $0 | 3.3 | 미착수 |
| 7 | DLQ 컨슈머 + 실패 안내 | 침묵 실패 제거 | $0 | 4.1 | 미착수 |
| 8 | 웹훅 secret **설정** | 할당량 도용 차단 | $0 | 6.1 | ✅ **완료 (2026-08-21). `POST /admin/set-webhook`으로 등록, `secretConfigured: true` 확인** |
| 9 | 텍스트 검색 지원 | 신규 기능 (Vision 0회) | $0 | 4.3 | 미착수 |
| 9-b | 검색 평가 하네스 (`POST /admin/eval`) | 회귀 방지 · 임계값 튜닝 근거 | $0 | 5.2 | ✅ **완료 (2026-08-21)** |
| 9-c | 검증 스킵을 "벡터·재정렬 일치 시에만"으로 | 오답 무검증 확정 차단 | $0 | 1.6 | ✅ **완료 (2026-08-21)** |
| 9-d | 업로드 임베딩을 큐 경로로 (VPN 불필요) | 지역 제한 우회 | $0 | 9.2 | ✅ **구현·배포 완료 (2026-08-23)** — 실업로드 검증 대기 |
| 10 | `search_logs` 기록 + 피드백 버튼 | 튜닝 근거 확보 | $0 | 5.2 / 4.4 | 미착수 |
| 11 | pg_trgm 하이브리드 검색 | 정확도 | $0 | 5.1 | 미착수 |
| 12 | README·ARCHITECTURE 문서 정정 | 포트폴리오 신뢰도 | $0 | 7장 | 미착수 |
| 13 | 미사용 인덱스 드랍 + VACUUM | 무료 티어 여유 | $0 | 3.6 | 미착수 |

### 8.1 2장 작업의 실행 순서 (의존성 있음)

3 → 3-b → 3-c → 3-d 순서를 지켜야 합니다. 특히 **3(`thinkingBudget: 0`)보다 3-b(`maxOutputTokens`)를 먼저 하면 빈 응답이 발생해 1.1 버그를 오히려 악화시킵니다** (2.6 참조). 3-d(호출 통합)는 프롬프트를 크게 건드리므로 앞의 세 개가 안정된 뒤에 하는 편이 원인 추적에 유리합니다.

각 단계 후에는 라벨 10~20장으로 추출 품질을 확인할 것. 비용 절감이 정확도 하락과 맞바꿔지지 않았는지는 측정 없이는 알 수 없고, 그 측정 기반이 5.2(`search_logs`)입니다.

---

## 9. 1차 개선 라운드 기록 (2026-08-21)

### 9.1 완료한 것

| 항목 | 근거 | 검증 방법 |
| --- | --- | --- |
| 추출 실패 시 에러 문자열 임베딩 차단 | 1.1 | 회귀 테스트 6건 + 배포 |
| Gemini 호출 REST 전환, thinking 비활성화 | 2.1 | 운영 실측 `thoughts: 0` (3개 호출 전부) |
| `rawText` 100자 상한 | 2.4 | 추출 output 412 → 118~168 토큰 |
| 숫자 매칭 오탐 수정 | 1.4 | 회귀 테스트 9건 + 실측 |
| 재정렬에 브랜드 매칭 추가, 보조 신호 게이트 | 1.4 / 1.5 | 실측 3/3, 이후 평가 4/4 |
| 검증 스킵을 두 신호 일치 조건으로 | 1.6 | 회귀 테스트 6건 |
| 웹훅 발신자 검증 활성화 | 6.1 | 운영 로그에서 경고 소멸 확인 |
| 검색 평가 하네스 | 5.2 | 2회 실행에서 유사도 소수점까지 재현 |

사진 1장당 비용은 대략 **절반 이하**로 떨어졌습니다(추출 output 412→120 수준, thinking 토큰 소멸). 정확한 절감 배수는 전환 이전 thinking 토큰 실측치가 없어 계산할 수 없습니다.

### 9.2 [추가] Gemini API 지역 제한 — 실행 PoP이 원인 (2026-08-23 실측으로 확정)

임베딩 호출이 **실행 경로에 따라** `User location is not supported for the API use`(400 FAILED_PRECONDITION)로 거절됩니다. 같은 API 키, 같은 코드입니다.

**원인**: Gemini는 호출 지역을 사람의 위치가 아니라 **API를 호출한 기계의 IP**로 판정합니다(구글 문서: "Region restrictions are applied based on the region that the Colab instance is in, not the region that the user is in"). Workers에서 그 기계는 Worker를 실행 중인 엣지 PoP입니다.

`/admin/colo-probe`로 측정한 값:

| 경로 | colo | Gemini |
|---|---|---|
| 관리자 HTTP (VPN 켬) | ICN 서울 | 통과 |
| 관리자 HTTP (VPN 끔) | **HKG 홍콩** | **0/20 실패** |
| 큐 컨슈머 | SJC 산호세 | 통과 |

확정된 사실:

- **홍콩은 Gemini 비허용 지역**입니다(한국·일본·싱가포르는 허용). 홍콩에 걸리면 100% 막힙니다 — 확률적이 아니라 결정적입니다.
- 이 개발 환경(한국 ISP)에서 VPN 없는 관리자 요청은 홍콩 PoP에 붙습니다. **업로드마다 VPN이 필요했던 원인이 이것입니다.** VPN은 사람의 위치가 아니라 붙는 PoP을 바꿔서 통했던 것입니다.
- **요청 안에서의 재시도는 무의미합니다.** 같은 colo에 갇혀 있어 20회를 시도해도 전부 실패합니다. `admin.ts`에 있던 `retryWithBackoff`(3회)도, 브라우저의 `fetchWithRetry`도 마찬가지입니다(같은 클라이언트는 같은 PoP에 안정적으로 붙음). 어제 업로드가 재시도를 뚫고 실패한 것이 이걸로 설명됩니다.
- **큐 컨슈머는 붙을 클라이언트가 없어 무관한 위치에서 실행됩니다.** 이것이 유일한 탈출 경로입니다. 큐 재시도는 새 실행이라 다른 colo를 잡을 기회도 됩니다.
- 참고: Smart Placement는 백엔드 근접 배치 휴리스틱이지 국가 지정 기능이 아니므로 해법이 되지 못합니다. 실측에서도 `ingress == colo`로 재배치가 일어나지 않았습니다.

**조치(2026-08-23 완료, 실업로드 검증 대기)**: 업로드의 임베딩 생성을 `embedding-queue`로 분리했습니다(9-d). `handleUploadChunk`는 임베딩 없이 INSERT하고 `{id, embeddingText}`를 큐에 보내며, 컨슈머가 임베딩을 채웁니다.

- 텍스트를 메시지에 실어 보내는 이유: 임베딩 원문은 DB에 저장되지 않습니다. DB에는 `"닷사이 23 (Dassai 23)"`(괄호 포함)만 있고 원문은 `"닷사이 23 Dassai 23 Asahi Shuzo Japan"`(괄호 없음)입니다. id만 보내고 재조립하면 임베딩 레시피가 두 종류로 갈립니다.
- 크기 한도는 제약이 아닙니다. Cloudflare Queues 메시지 한도는 128 KB인데 `{id, text}` 50건은 약 5 KB입니다. 엑셀 행 전체를 실었다면 350~450행에서 걸렸을 것입니다.
- 컨슈머는 오류를 분류하지 않고 무조건 재시도합니다. id로 UPDATE하므로 멱등이기 때문입니다.
- `max_concurrency = 3`으로 묶었습니다. 미지정 시 백로그에 따라 250까지 확장되어 Gemini 레이트 리밋에 걸립니다.
- 진단 수단을 남겼습니다: `/admin/colo-probe?n=20`(실행 colo + Gemini 통과 여부), `/admin/embedding-status`(임베딩 미채움 행 수), `/admin/embed-selftest`(DB 변경 없이 큐 경로 점검).
- **미검증**: 실제 업로드 데이터가 없어 INSERT의 id 회수와 순서 매칭은 아직 실물로 확인하지 못했습니다. 다음 업로드가 첫 실행입니다.
- **남은 것**: 진짜 자가 복구(DLQ까지 빠진 행 복구)를 하려면 `embedding_text` 컬럼이 필요합니다. 현재는 원문을 재조립할 수 없어 `/admin/embedding-status`로 드러내기만 합니다.

### 9.3 이번 라운드에서 원래 진단이 틀린 것으로 밝혀진 항목

- **1.6의 제안** — "스킵 판정을 재정렬 이전의 벡터 1위 기준으로 바꾸면 해소된다"는 **틀렸습니다.** 실측에서 벡터 1위가 0.8544짜리 오답이고 정답이 2위(0.8172)인 케이스가 나왔습니다. 벡터 1위 기준으로 판정하면 오답이 검증 없이 확정됩니다. 올바른 조건은 두 신호의 **일치** 여부입니다.
- **2.7의 추정** — "이미지 input이 지배적 비용"이라는 추정은 틀렸습니다. 실측에서 이미지는 250토큰 남짓이었습니다.

### 9.4 방법론에서 배운 것

**Gemini 추출은 `temperature: 0`에서도 비결정적입니다.** 같은 사진에서 `exporterEnglish`와 `rawText`가 실행마다 갈렸고, 그 변동폭(유사도 0.09)이 검색 로직 변경의 효과(0.01~0.03)보다 컸습니다. 이 때문에 검색어 생성 방식을 바꾸는 실험 두 라운드가 결론을 내지 못했고 결국 기각했습니다(2.9).

반면 **검색어 생성 → 임베딩 → 벡터검색 → 재정렬 구간은 완전히 결정론적입니다.** 평가 하네스를 2회 실행했을 때 유사도가 소수점까지 동일했습니다. 따라서 검색 단계를 튜닝할 때는 추출 JSON을 고정한 평가 하네스를 쓰고, 사진부터 돌리는 방식은 앞단 변동이 뒷단 측정을 덮어쓰므로 쓰지 않습니다.

교훈: **측정 수단을 먼저 만들었어야 했습니다.** 하루 동안 회귀가 세 번(하쿠로슈주·마코토·로센데) 났는데 전부 사후에 발견했습니다.

### 9.5 다음 라운드 권장 순서

1. ~~**업로드를 큐 경로로** (9-d)~~ — 2026-08-23 완료. 다만 **실업로드 검증이 남아 있습니다**(9.2 참조). 다음에 데이터가 생기면 이것부터 확인할 것.
2. **실 DB 상태 확인** (2순위) — 3장 전체가 여기에 걸려 있습니다. 총평의 세 문제 중 유일하게 손대지 않은 덩어리입니다.
3. **문서 정정** (12순위) — README의 "이미지끼리 비교" 서술은 포트폴리오 신뢰도에 직결됩니다.
4. `verifyMatch`의 kg 값 제거(4순위), `ef_search` 추가(5순위) — 둘 다 작고 효과가 분명합니다.

### 9.6 운영 메모

- `ADMIN_CHAT_ID`가 설정되지 않아 `logErrorAndNotify`의 알림이 전부 유실되고 있습니다. 평가 결과도 텔레그램으로 오지 않습니다.
- 와인 데이터가 아직 적재되지 않아 평가 픽스처 5개 중 와인 1건이 실패합니다. 정상이며, 데이터를 넣으면 통과합니다.
- 평가 픽스처는 현재 재정렬이 0.82 넘는 후보를 끌어올리는 조합을 담고 있지 않아, 9-c의 새 스킵 규칙을 실데이터로는 시험하지 못합니다(단위 테스트로는 덮여 있음). 그런 사례를 만나면 픽스처로 추가할 것.
- 다음 업로드 시 확인할 것: ① `/admin/embedding-status`의 `pending`이 올라갔다가 0으로 수렴하는지 ② 로그의 `[EMBED] Filled n/n`에서 두 수가 같은지(다르면 id 매칭이 틀린 것) ③ `[COLO] queue/embed`의 colo가 허용 지역인지. **VPN은 끄고 하세요** — 켜면 이번 작업이 실제로 효과가 있었는지 알 수 없습니다.
- 큐 생성은 설치된 wrangler 4.54로 안 됩니다(`The specified queue settings are invalid.`). Node 24 + `npx -y wrangler@latest queues create`를 써야 합니다. 루트 `CLAUDE.md`에 기록해 두었습니다.

---

## 부록: 실 DB 확인 쿼리 (2순위 작업용)

```sql
-- ① 제약 조건 (fix_unique_constraint.sql 적용 여부)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid = 'sake_imports'::regclass;

-- ② 인덱스 실물 (halfvec/vector, HNSW/IVFFlat, 복합 인덱스 개수)
SELECT indexname, indexdef, pg_size_pretty(pg_relation_size(indexname::regclass))
FROM pg_indexes WHERE tablename = 'sake_imports';

-- ③ 함수 실물 (bulk_update 버전, hybrid_search 존재 여부, 오버로드)
SELECT proname, pg_get_function_arguments(oid)
FROM pg_proc WHERE proname IN
  ('bulk_update_sake_imports','search_products','hybrid_search_products','get_stats');

-- ④ 블로트
SELECT n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'sake_imports';

-- ⑤ 컬럼 타입 (name_embedding이 halfvec인지 vector인지)
SELECT column_name, udt_name FROM information_schema.columns
WHERE table_name = 'sake_imports';
```
