import type { Env, SearchResult, Product, ProductCategory, ExtractedLabelInfo } from '../types';
import { extractLabelInfo, getEmbedding, verifyMatch } from './gemini';
import { vectorSearch } from './database';
import { arrayBufferToBase64 } from '../utils/encoding';
import { logErrorAndNotify } from '../utils/logger';

const CONFIDENCE_THRESHOLD = 70;
const HIGH_CONFIDENCE_SKIP_THRESHOLD = 0.82;

export async function searchProduct(env: Env, imageUrl: string): Promise<SearchResult> {
  console.log('[SEARCH] Starting search for image:', imageUrl.substring(0, 50) + '...');

  let base64Image: string;
  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) throw new Error('Failed to fetch image');

    const imageBuffer = await imageResponse.arrayBuffer();

    if (imageBuffer.byteLength > 5 * 1024 * 1024) {
      throw new Error('Image size exceeds 5MB limit');
    }

    base64Image = arrayBufferToBase64(imageBuffer);

  } catch (e) {
    await logErrorAndNotify(env, '[SEARCH] Image download/processing failed:', e);

    return {
      found: false,
      confidence: 0,
      product: null,
      candidates: [],
      extractedInfo: null,
      message: '이미지를 처리하는 중 오류가 발생했습니다. (파일이 너무 크거나 형식이 지원되지 않습니다)',
    };
  }

  // Retry Logic for Extraction consistency
  const MAX_RETRIES = 2;
  let lastResult: SearchResult | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[SEARCH] Attempt ${attempt}/${MAX_RETRIES}`);

    try {
      lastResult = await executeSearchPipeline(env, base64Image);

      // If found (High confidence), return immediately
      if (lastResult.found) {
        return lastResult;
      }

      // Optimization: If extraction was high confidence (>70) and we verified candidates but found no match,
      // it is likely that the product is simply not in the database.
      // Retrying extraction is unlikely to help and risks hitting Worker timeout.
      if (lastResult.extractedInfo && lastResult.extractedInfo.confidence >= 70) {
        console.log('[SEARCH] Extraction confidence is high. Skipping retry to save time/resources.');
        return lastResult;
      }

      // If this is not the last attempt, allow retry
      if (attempt < MAX_RETRIES) {
        console.log('[SEARCH] Attempt failed to find match. Retrying extraction...');
      }

    } catch (error) {
      console.error(`[SEARCH] Attempt ${attempt} error:`, error);
      if (attempt === MAX_RETRIES) {
        await logErrorAndNotify(env, '[SEARCH] All attempts failed:', error);
        return {
          found: false,
          confidence: 0,
          product: null,
          candidates: [],
          extractedInfo: null,
          message: '일시적인 검색 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
        };
      }
    }
  }

  console.log('[SEARCH] Max retries reached. Returning last result.');
  return lastResult!;
}

// Extracted internal function to keep code clean and retry-able
async function executeSearchPipeline(env: Env, base64Image: string): Promise<SearchResult> {
  const extracted = await extractLabelInfo(env, base64Image);
  console.log('[SEARCH] Extracted info:', JSON.stringify(extracted));

  if (extracted.errorType === 'RATE_LIMIT') {
    console.log('[SEARCH] Rate limit exceeded');
    return {
      found: false,
      confidence: 0,
      product: null,
      candidates: [],
      extractedInfo: extracted,
      message: '⚠️ AI 서버 사용량 한도 초과입니다. 잠시 후 다시 시도해주세요.',
    };
  }

  if (!isExtractionUsable(extracted)) {
    console.log('[SEARCH] Extraction unusable. errorType:', extracted.errorType ?? 'none');
    return {
      found: false,
      confidence: 0,
      product: null,
      candidates: [],
      extractedInfo: extracted,
      // 추출 자체가 실패한 것과 라벨을 못 읽은 것은 사용자가 취할 행동이 다르다.
      message: extracted.errorType
        ? '라벨 분석에 실패했습니다. 잠시 후 다시 시도해주세요.'
        : '라벨을 인식할 수 없습니다. 더 선명한 사진을 보내주세요.',
    };
  }

  const searchText = buildSearchText(extracted);
  console.log('[SEARCH] Search text:', searchText);

  let embedding: number[];
  let candidates: Product[];

  try {
    embedding = await getEmbedding(env, searchText);
    console.log('[SEARCH] Embedding generated, length:', embedding.length);

    candidates = await vectorSearch(env, embedding, 50, 0.5, extracted.productType);
    console.log('[SEARCH] Vector search returned', candidates.length, 'candidates');
  } catch (error) {
    // Let the caller handle the error (to log retry or fail)
    throw error;
  }

  if (candidates.length === 0) {
    console.log('[SEARCH] No candidates found');
    return {
      found: false,
      confidence: extracted.confidence,
      product: null,
      candidates: [],
      extractedInfo: extracted,
      message: '수입 목록에서 찾을 수 없습니다.',
    };
  }

  if (candidates.length > 0) {
    console.log('[SEARCH] Top candidate:', candidates[0].reported_product_name, 'Similarity:', candidates[0].similarity);
  }

  const reorderedCandidates = prioritizeByMetadata(candidates, extracted);
  console.log('[SEARCH] After metadata prioritization, top is:', reorderedCandidates[0].reported_product_name);

  const topCandidate = reorderedCandidates[0];
  const topCandidates = reorderedCandidates.slice(0, 3);

  const similarity = topCandidate.similarity ?? 0;

  // High confidence Logic:
  // 1. Absolute similarity is very high (>= 0.82)
  // 2. OR Absolute similarity is reasonably high (>= 0.75) AND there is a significant gap (> 0.15) between 1st and 2nd candidate
  const secondSimilarity = reorderedCandidates.length > 1 ? (reorderedCandidates[1].similarity ?? 0) : 0;
  const similarityGap = similarity - secondSimilarity;

  if (
    similarity >= HIGH_CONFIDENCE_SKIP_THRESHOLD ||
    (similarity >= 0.75 && similarityGap > 0.15)
  ) {
    console.log('[SEARCH] High confidence match! Skipping verification. Similarity:', similarity, 'Gap:', similarityGap);
    return {
      found: true,
      confidence: Math.min(95, Math.round(similarity * 100)),
      product: topCandidate,
      candidates: topCandidates,
      extractedInfo: extracted,
      message: '제품을 찾았습니다.',
    };
  }

  console.log('[SEARCH] Verifying match with', topCandidates.length, 'candidates');

  const verification = await verifyMatch(env, base64Image, topCandidates, extracted.productType);
  console.log('[SEARCH] Verification result:', JSON.stringify(verification));

  if (verification.matchedIndex > 0 && verification.confidence >= CONFIDENCE_THRESHOLD) {
    const matchedProduct = topCandidates[verification.matchedIndex - 1];
    return {
      found: true,
      confidence: verification.confidence,
      product: matchedProduct,
      candidates: topCandidates,
      extractedInfo: extracted,
      message: '제품을 찾았습니다.',
    };
  }

  if (verification.confidence >= 50 && verification.confidence < CONFIDENCE_THRESHOLD) {
    return {
      found: false,
      confidence: verification.confidence,
      product: topCandidates[0],
      candidates: topCandidates,
      extractedInfo: extracted,
      message: '불확실합니다. 아래 제품이 맞는지 확인해주세요.',
    };
  }

  return {
    found: false,
    confidence: verification.confidence,
    product: null,
    candidates: topCandidates,
    extractedInfo: extracted,
    message: '수입 목록에서 찾을 수 없습니다.',
  };
}

// ============================================
// Search Text Builder (Type-Aware)
// ============================================
/**
 * 용량·도수처럼 라벨 어디에나 있어서 제품을 구분하지 못하는 숫자.
 * 매칭에 쓰면 무관한 제품에 가산점이 붙는다.
 */
const NON_IDENTIFYING_NUMBERS = new Set([
  '180', '200', '300', '330', '375', '500', '640', '720', '750', '900', '1000', '1500', '1800',
]);

/**
 * 가산점 계산에 쓸 만한 숫자만 남긴다.
 *
 * 프롬프트에서 numbers의 범위를 좁혔지만 모델 출력을 그대로 믿을 수는 없다.
 * 실측에서 한 라벨의 numbers가 ["25","900","1","37","1","099","268","2020","251714"]로
 * 나온 적이 있는데, 여기서 "1"은 이름에 1이 들어간 거의 모든 제품에 매칭되어
 * 메타데이터 재정렬을 사실상 무작위로 만든다.
 *
 * - 2자리 미만은 버린다 (한 자리 숫자는 어디에나 걸린다)
 * - 숫자가 아닌 문자열은 버린다
 * - 용량성 숫자는 제외 목록으로 버린다
 */
export function meaningfulNumbers(numbers: string[]): string[] {
  return numbers.filter(n => /^\d{2,}$/.test(n) && !NON_IDENTIFYING_NUMBERS.has(n));
}

/**
 * 제품명에 해당 숫자가 "독립된 수"로 등장하는지 본다.
 *
 * 단순 `includes`는 "23"을 "2023 빈티지"에, "39"를 "1390"에 매칭시킨다.
 * 앞뒤가 숫자가 아닐 때만 일치로 친다.
 */
export function hasNumberMatch(productName: string, numbers: string[]): boolean {
  return meaningfulNumbers(numbers).some(num =>
    new RegExp(`(?<!\\d)${num}(?!\\d)`).test(productName)
  );
}

/**
 * 추출 결과를 검색어 재료로 쓸 수 있는지 판정한다.
 *
 * 추출이 실패하면 `createEmptyExtraction`이 confidence 0 + errorType이 채워진 객체를
 * 돌려준다. 예전에는 그 객체의 rawText에 에러 메시지가 담겨 있었고, 가드가
 * `!rawText && !brand`뿐이라 이 상태가 그대로 통과했다. 그 결과
 * "Error: Timeout after 20000ms"를 임베딩해 벡터 검색을 돌리고, 유사도 0.5를 넘긴
 * 무관한 제품이 후보로 올라와 오답으로 확정될 여지가 있었다.
 *
 * errorType과 confidence를 둘 다 보는 것은 의도적이다. 지금은 두 조건이 같이 움직이지만,
 * 나중에 다른 경로로 confidence 0짜리 결과가 만들어져도 검색으로 새지 않게 한다.
 */
export function isExtractionUsable(extracted: ExtractedLabelInfo): boolean {
  if (extracted.errorType) return false;
  if (extracted.confidence === 0) return false;
  return Boolean(extracted.rawText || extracted.brand);
}

function buildSearchText(extracted: ExtractedLabelInfo): string {
  if (extracted.productType === 'Wine' || extracted.productType === 'Etc-Wine') {
    // Wine search: prioritize winery, region, grape, vintage
    return [
      extracted.exporterEnglish,  // Winery name (most important)
      extracted.region,
      extracted.grapeVariety,
      extracted.vintage,
      extracted.brand,
      extracted.brandKorean,
      extracted.brandEnglish,
      extracted.rawText
    ].filter(Boolean).join(' ');
  } else {
    // Sake/Other search (existing logic)
    return [
      extracted.brand,
      extracted.brandKorean,
      extracted.brandEnglish,
      extracted.exporterEnglish,
      extracted.rawText
    ].filter(Boolean).join(' ');
  }
}

// ============================================
// Metadata Prioritization (Dispatch)
// ============================================
function prioritizeByMetadata(
  candidates: Product[],
  extracted: ExtractedLabelInfo
): Product[] {
  if (extracted.productType === 'Wine' || extracted.productType === 'Etc-Wine') {
    return prioritizeWineByMetadata(candidates, extracted);
  } else {
    return prioritizeSakeByMetadata(candidates, extracted);
  }
}

// ============================================
// Wine Prioritization (Product Name Parsing)
// Priority: Winery (100pt) > Region = Grape (50pt) > Vintage (30pt)
// ============================================
function prioritizeWineByMetadata(
  candidates: Product[],
  extracted: ExtractedLabelInfo
): Product[] {
  const scored = candidates.map(c => {
    let score = 0;
    const productName = c.reported_product_name.toLowerCase();
    const exporter = (c.exporter || '').toLowerCase();

    // Priority 1: Winery/Exporter (100 points max)
    if (extracted.exporterEnglish) {
      const extractedWinery = extracted.exporterEnglish.toLowerCase();

      // Perfect match in exporter field
      if (exporter === extractedWinery) {
        score += 100;
      }
      // Partial match in exporter field
      else if (exporter.includes(extractedWinery) || extractedWinery.includes(exporter)) {
        score += 80;
      }
      // Found in product name
      else if (productName.includes(extractedWinery)) {
        score += 60;
      }
      // Word-level matching (e.g., "Château Margaux" vs "Margaux")
      else {
        const wineryWords = extractedWinery.split(/\s+/);
        const matchedWords = wineryWords.filter(word =>
          word.length > 3 && (exporter.includes(word) || productName.includes(word))
        );
        score += matchedWords.length * 20;
      }
    }

    // Priority 2: Region (50 points) - Equal with Region
    if (extracted.region) {
      const region = extracted.region.toLowerCase();
      if (productName.includes(region) || exporter.includes(region)) {
        score += 50;
      }
    }

    // Priority 2: Grape Variety (50 points) - Equal with Region
    if (extracted.grapeVariety) {
      const grape = extracted.grapeVariety.toLowerCase();
      if (productName.includes(grape) || exporter.includes(grape)) {
        score += 50;
      }
    }

    // Priority 3: Vintage (30 points) - Lowest
    // 단어 경계 검사: "2018"이 "20180"에 걸리지 않도록.
    if (extracted.vintage && hasNumberMatch(productName, [extracted.vintage])) {
      score += 30;
    }

    return { product: c, score };
  });

  // Sort by score descending, then by vector similarity
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.product.similarity || 0) - (a.product.similarity || 0);
  });

  return scored.map(s => s.product);
}

// ============================================
// Sake Prioritization (Exporter + Number Matching)
// ============================================
function prioritizeSakeByMetadata(
  candidates: Product[],
  extracted: ExtractedLabelInfo
): Product[] {
  // Score each candidate
  const scored = candidates.map(c => {
    let score = 0;
    const productName = c.reported_product_name.toLowerCase();
    const dbExporter = (c.exporter || '').toLowerCase();

    // Priority 1: Exporter matching (NEW)
    if (extracted.exporterEnglish) {
      const extractedExporter = extracted.exporterEnglish.toLowerCase();

      // Perfect match
      if (dbExporter === extractedExporter) {
        score += 100;
      }
      // Partial match: "higashi shuzo" ⊂ "kinpo factory higashi shuzo"
      else if (dbExporter.includes(extractedExporter) || extractedExporter.includes(dbExporter)) {
        score += 80;
      }
      // Found in product name
      else if (productName.includes(extractedExporter)) {
        score += 60;
      }
      // Word-level matching: significant words (length > 3)
      else {
        const exporterWords = extractedExporter.split(/\s+/);
        const significantWords = exporterWords.filter(w => w.length > 3);
        const matchedWords = significantWords.filter(w =>
          dbExporter.includes(w) || productName.includes(w)
        );
        score += matchedWords.length * 20;
      }
    }

    // Priority 2: Number matching (등급·정미비율 등 식별성 있는 숫자만)
    if (hasNumberMatch(productName, extracted.numbers)) {
      score += 50;
    }

    return { product: c, score };
  });

  // If any candidate has a score, sort by score then similarity
  if (scored.some(s => s.score > 0)) {
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.product.similarity || 0) - (a.product.similarity || 0);
    });
    return scored.map(s => s.product);
  }

  // Fallback: no scores → return original order (vector similarity order)
  return candidates;
}
