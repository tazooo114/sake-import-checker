import type { Env, ExtractedLabelInfo, ProductCategory } from '../types';
import { logErrorAndNotify } from '../utils/logger';

const PRIMARY_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODEL = 'gemini-2.0-flash';
const EMBEDDING_MODEL = 'gemini-embedding-001';

const GENERATE_TIMEOUT_MS = 20000; // 20 seconds
const EMBEDDING_TIMEOUT_MS = 10000; // 10 seconds

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * thinking을 지원하는 모델에만 thinkingConfig를 붙인다.
 *
 * `gemini-2.0-flash`(FALLBACK_MODEL)는 thinking이 없고, 이 필드를 받았을 때
 * 무시하는지 400으로 거절하는지 확인되지 않았다. 폴백 경로는 primary가 이미 실패한
 * 뒤에만 타므로 여기서 터지면 장애가 이중이 된다. 확실한 쪽만 보낸다.
 */
function supportsThinking(modelName: string): boolean {
  return modelName.startsWith('gemini-2.5');
}

/**
 * REST로 generateContent를 호출한다.
 *
 * 레거시 SDK(`@google/generative-ai@0.21`)는 `thinkingConfig`를 지원하지 않는데,
 * gemini-2.5-flash는 thinking이 기본 활성화라 호출마다 보이지 않는 thinking 토큰이
 * output 단가로 과금된다. 라벨 추출·후보 선택에는 불필요한 비용이라 REST로 직접
 * 호출해 `thinkingBudget: 0`을 지정한다. 임베딩(getEmbedding)이 쓰던 패턴과 동일하다.
 */
async function generateContentREST(
  env: Env,
  modelName: string,
  prompt: string,
  base64Image: string,
  mimeType: string
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${env.GEMINI_API_KEY}`;

  const generationConfig: Record<string, unknown> = {
    // 추출·선택 작업에 샘플링 다양성은 손해다.
    temperature: 0,
  };
  if (supportsThinking(modelName)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Image } },
          ],
        }],
        generationConfig,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      // REST에서는 상태 코드로 직접 판별한다 (기존의 문자열 매칭보다 확실).
      if (response.status === 429) {
        throw new RateLimitError(`${modelName} rate limited: ${errorText.slice(0, 200)}`);
      }
      throw new Error(`${modelName} HTTP ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as GenerateContentResponse;

    // thinkingBudget이 실제로 먹었는지는 thoughtsTokenCount로만 확인할 수 있다.
    // 0이 아니면 설정이 무시된 것이므로 이 로그를 반드시 확인할 것.
    const usage = data.usageMetadata;
    if (usage) {
      console.log(
        `[Gemini] ${modelName} tokens — prompt: ${usage.promptTokenCount ?? '?'}, ` +
        `output: ${usage.candidatesTokenCount ?? '?'}, thoughts: ${usage.thoughtsTokenCount ?? 0}`
      );
    }

    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map(part => part.text ?? '')
      .join('');

    if (!text) {
      // finishReason이 MAX_TOKENS면 상한이 너무 낮은 것이다.
      throw new Error(
        `${modelName} returned no text (finishReason: ${candidate?.finishReason ?? 'unknown'})`
      );
    }

    return text;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Timeout after ${GENERATE_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generateContentWithFallback(
  env: Env,
  prompt: string,
  base64Image: string,
  mimeType: string
): Promise<string> {
  const models = [PRIMARY_MODEL, FALLBACK_MODEL];
  let lastRateLimitError: Error | null = null;

  for (const modelName of models) {
    try {
      return await generateContentREST(env, modelName, prompt, base64Image, mimeType);
    } catch (error: any) {
      console.warn(`[Gemini] ${modelName} failed: ${error}`);

      const errorStr = String(error);
      if (error instanceof RateLimitError || errorStr.includes('429') || errorStr.includes('quota')) {
        lastRateLimitError = error;
      }

      if (modelName === FALLBACK_MODEL) {
        if (lastRateLimitError) {
          throw new RateLimitError(String(lastRateLimitError));
        }
        throw error;
      }
    }
  }
  throw new Error('All models failed');
}

// ============================================
// Product Type Detection
// ============================================
export async function detectProductType(
  env: Env,
  base64Image: string,
  mimeType: string = 'image/jpeg'
): Promise<ProductCategory> {
  const prompt = `
이 술병/라벨 이미지를 보고 제품 종류를 판단하세요.

분류 기준:
- **Sake**: 일본 사케, 일본어 라벨 (히라가나/가타카나/한자), "純米", "大吟醸", "本醸造" 등의 키워드
- **Wine**: 와인 병, 유럽/미국 라벨, "Winery", "Vineyard", "Château", "Red/White Wine", 포도 품종명, 빈티지 연도 (2015, 2018 등)

응답은 반드시 다음 중 하나만 출력하세요:
"Sake" 또는 "Wine"

추론이 불확실하면 라벨의 언어와 키워드를 기준으로 판단하세요.
`.trim();

  try {
    const responseText = (await generateContentWithFallback(env, prompt, base64Image, mimeType)).trim();

    console.log('[Gemini] Product type detection result:', responseText);

    if (responseText.includes('Wine')) return 'Wine';
    if (responseText.includes('Sake')) return 'Sake';

    // Default to Sake for backward compatibility
    return 'Sake';
  } catch (error) {
    console.error('[Gemini] Product type detection failed:', error);
    return 'Sake'; // Safe default
  }
}

// ============================================
// Extraction Prompts by Product Type
// ============================================
function getSakeExtractionPrompt(): string {
  return `
이 사케/주류 라벨 이미지를 분석하고 다음 정보를 JSON 형식으로 추출하세요:

1. brand: 브랜드/제품 이름 (라벨에 보이는 그대로)
2. brandKorean: 브랜드 이름의 한글 발음 표기 (예: がんばれ → 간바레, 獺祭 → 닷사이, 久保田 → 쿠보타)
3. brandEnglish: 브랜드 이름의 영어/로마자 표기
4. exporterEnglish: 제조사/양조장 이름의 영어 표기 (가장 중요! 예: 旭酒造 → Asahi Shuzo, 宝酒造 → Takara Shuzo)
5. exporterOriginal: 제조사/양조장 이름의 원문 표기 (한자/일본어) (예: 旭酒造, 宝酒造, 株式会社 木村酒造)
6. numbers: 라벨에 보이는 모든 숫자들 (예: ["23", "39", "45", "720"])
    - 중요: 한자 숫자는 아라비아 숫자로 변환 (예: "二割三分" → "23", "三割九分" → "39", "四割五分" → "45")
7. volume: 용량 (예: "720ml", "1800ml", "1.8L", "900ml")
8. rawText: 라벨에서 읽을 수 있는 모든 텍스트

중요 변환 규칙:

【영문 표기 우선 원칙】
- brandEnglish: 라벨에 영어/로마자가 직접 인쇄되어 있다면, AI 변환 없이 라벨의 영문 그대로 사용하세요.
  라벨에 영문이 없는 경우에만 한자/가나를 변환하세요.
  예: 라벨에 "KATSU MUTEKATSURYU"가 적혀 있으면 → brandEnglish: "Katsu Mutekatsuryu" (그대로 사용)
- exporterEnglish도 동일하게 라벨에 영문이 있으면 그대로 사용하고, 없으면 변환하세요.

【한자 읽기 원칙】
- 일본 주류 라벨의 한자는 일본어 발음(음독/훈독)으로 읽으세요. 한국어 한자 음독이 아닙니다.
  예: 克 → 카츠(カツ), NOT 극 / 獺 → 달이 아닌 닷(다) / 祭 → 사이
- 단, 한국 시장에서 관용적으로 굳어진 이름은 예외입니다.
  예: 松竹梅 → 한국에서는 "송죽매"로 널리 알려져 있으므로 brandKorean: "송죽매" 허용

- 제조사(Exporter) 영문 표기가 불확실하면 검색 가능한 가장 일반적인 표기를 사용하세요.
- 숫자 변환에 주의하세요 ("二" -> "2", "三" -> "3", "割" -> 무시/단위).

응답은 반드시 다음 JSON 형식으로만 해주세요:
{"brand": "", "brandKorean": "", "brandEnglish": "", "exporterEnglish": "", "exporterOriginal": "", "numbers": [], "volume": "", "rawText": ""}
`.trim();
}

function getWineExtractionPrompt(): string {
  return `
이 와인 라벨 이미지를 분석하고 다음 정보를 JSON 형식으로 추출하세요:

추출 우선순위 (중요도 순):
1. exporterEnglish: 와이너리/생산자 영문명 (가장 중요! 예: "Château Margaux", "Penfolds", "Robert Mondavi Winery")
2. exporterOriginal: 와이너리/생산자 원문명 (프랑스어/이탈리아어 등 현지 표기)
3. region: 생산 지역 (예: "Bordeaux", "Napa Valley", "Barossa Valley", "Burgundy", "Tuscany")
3. grapeVariety: 포도 품종 (예: "Cabernet Sauvignon", "Pinot Noir", "Chardonnay", "Merlot", "Syrah")
4. vintage: 빈티지 연도 (예: "2018", "2020", "2015")

기타 정보:
5. brand: 브랜드/제품 라인명 (예: "Yellow Label", "Reserve", "Grand Vin")
6. brandKorean: 브랜드의 한글 발음 (예: "Château Margaux" → "샤또 마고", "Penfolds" → "펜폴즈")
7. brandEnglish: 브랜드의 영어 표기 (라벨 그대로)
8. numbers: 라벨에 보이는 숫자들 (빈티지 연도, 알코올 도수 등) (예: ["2018", "14", "750"])
9. volume: 용량 (예: "750ml", "1.5L", "375ml")
10. rawText: 라벨에서 읽을 수 있는 모든 텍스트

중요 주의사항:
- exporterEnglish(와이너리)는 검색의 핵심입니다. 정확하게 추출하세요.
- region은 AOC/DOC 표기나 지역명을 찾으세요 (예: "Appellation Bordeaux Contrôlée" → "Bordeaux")
- grapeVariety는 라벨에 명시된 포도 품종을 찾으세요
- vintage는 라벨에 가장 크게 표시된 4자리 연도입니다

응답은 반드시 다음 JSON 형식으로만 해주세요:
{"exporterEnglish": "", "exporterOriginal": "", "region": "", "grapeVariety": "", "vintage": "", "brand": "", "brandKorean": "", "brandEnglish": "", "numbers": [], "volume": "", "rawText": ""}
`.trim();
}

// ============================================
// Label Information Extraction (Polymorphic)
// ============================================
export async function extractLabelInfo(
  env: Env,
  base64Image: string,
  mimeType: string = 'image/jpeg'
): Promise<ExtractedLabelInfo> {
  // Step 1: Detect product type (Sake or Wine)
  const productType = await detectProductType(env, base64Image, mimeType);
  console.log('[Gemini] Detected product type:', productType);

  // Step 2: Use type-specific extraction prompt
  const prompt = productType === 'Wine'
    ? getWineExtractionPrompt()
    : getSakeExtractionPrompt();

  try {
    const responseText = await generateContentWithFallback(env, prompt, base64Image, mimeType);
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      // 진단 정보는 로그로만 남긴다. 이 문자열을 추출 결과에 실어 보내면
      // 그대로 검색어가 된다 (search.ts의 isExtractionUsable 주석 참조).
      console.error('[Gemini] Response was not JSON:', responseText.slice(0, 200));
      return createEmptyExtraction('PARSE_FAILED', productType);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Build polymorphic response
    const extracted: ExtractedLabelInfo = {
      productType,
      brand: parsed.brand || '',
      brandKorean: parsed.brandKorean || '',
      brandEnglish: parsed.brandEnglish || '',
      exporterEnglish: parsed.exporterEnglish || '',
      exporterOriginal: parsed.exporterOriginal || '',
      numbers: Array.isArray(parsed.numbers) ? parsed.numbers : [],
      volume: parsed.volume || '',
      rawText: parsed.rawText || '',
      confidence: parsed.brand || parsed.exporterEnglish ? 80 : 50,
    };

    // Add wine-specific metadata (for search prioritization)
    if (productType === 'Wine') {
      extracted.region = parsed.region || '';
      extracted.grapeVariety = parsed.grapeVariety || '';
      extracted.vintage = parsed.vintage || '';
    }

    return extracted;
  } catch (error: any) {
    await logErrorAndNotify(env, '[Gemini] Extraction failed:', error);
    const isRateLimit = error instanceof RateLimitError ||
      String(error).includes('429') ||
      String(error).includes('quota');
    return createEmptyExtraction(isRateLimit ? 'RATE_LIMIT' : 'EXTRACTION_FAILED', productType);
  }
}

/**
 * 추출 실패를 나타내는 빈 결과를 만든다.
 *
 * 진단 문자열(에러 메시지, 파싱 못 한 응답 등)은 **절대 여기에 담지 않는다**.
 * 과거에는 rawText에 `String(error)`를 넣었는데, rawText가 검색어 재료라서
 * "Error: Timeout after 20000ms" 같은 문자열이 그대로 임베딩되어 벡터 검색에
 * 쓰였다. 진단은 호출부에서 로그로 남긴다.
 */
function createEmptyExtraction(
  errorType: NonNullable<ExtractedLabelInfo['errorType']>,
  productType: ProductCategory = 'Sake'
): ExtractedLabelInfo {
  return {
    productType,
    brand: '',
    brandKorean: '',
    brandEnglish: '',
    exporterEnglish: '',
    exporterOriginal: '',
    numbers: [],
    volume: '',
    rawText: '',
    confidence: 0,
    errorType,
  };
}

export async function getEmbedding(env: Env, text: string): Promise<number[]> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${env.GEMINI_API_KEY}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: 768
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API Error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as any;
    return data.embedding.values;
  } catch (error) {
    console.error('[Gemini] Embedding failed:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Embedding timed out after ${EMBEDDING_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

export async function getBatchEmbeddings(env: Env, texts: string[]): Promise<number[][]> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${env.GEMINI_API_KEY}`;

    const requests = texts.map(text => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: 768
    }));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API Error: ${response.status} ${errorText}`);
    }

    const result = await response.json() as any;

    if (!result.embeddings) {
      return texts.map(() => []);
    }

    return result.embeddings.map((e: any) => e.values);
  } catch (error) {
    console.error('[Gemini] Batch embedding failed:', error);
    throw error;
  }
}

export async function verifyMatch(
  env: Env,
  base64Image: string,
  candidates: Array<{ reported_product_name: string; volume?: number | null; category?: ProductCategory | null }>,
  productType: ProductCategory = 'Sake',  // NEW: product type for context
  mimeType: string = 'image/jpeg'
): Promise<{ matchedIndex: number; confidence: number }> {

  const candidateList = candidates
    .map((c, i) => `${i + 1}. ${c.reported_product_name} (${c.volume || '용량 미상'})`)
    .join('\n');

  const productLabel = (productType === 'Wine' || productType === 'Etc-Wine') ? '와인' : '사케';

  const prompt = `
이 ${productLabel} 병 이미지와 가장 일치하는 제품을 선택하세요.

후보 목록:
${candidateList}

응답은 반드시 다음 JSON 형식으로만 해주세요:
{"matchedIndex": 번호(1부터 시작), "confidence": 확신도(0-100)}

일치하는 제품이 없으면 matchedIndex를 0으로 설정하세요.
`.trim();

  try {
    const responseText = await generateContentWithFallback(env, prompt, base64Image, mimeType);
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.error('[Gemini] Verification response was not JSON:', responseText.slice(0, 200));
      return { matchedIndex: 0, confidence: 0 };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      matchedIndex: typeof parsed.matchedIndex === 'number' ? parsed.matchedIndex : 0,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    };
  } catch (error) {
    console.error('[Gemini] Verification failed:', error);
    return { matchedIndex: 0, confidence: 0 };
  }
}
