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
  const secondSimilarity = reorderedCandidates.length > 1 ? (reorderedCandidates[1].similarity ?? 0) : 0;
  const similarityGap = similarity - secondSimilarity;

  if (shouldSkipVerification(candidates[0], reorderedCandidates)) {
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

/**
 * verifyMatch(Vision 호출)를 건너뛰어도 되는지 판정한다.
 *
 * **벡터 1위와 재정렬 1위가 같은 제품일 때만** 스킵한다. 둘이 다르다는 것은
 * 두 신호가 서로 다른 답을 가리킨다는 뜻이고, 그때가 바로 검증이 필요한 순간이다.
 *
 * 이 조건이 없으면 어느 쪽으로든 오답이 확정될 수 있다. 2026-08-21 실측:
 *
 *   克 新 無手勝流 — 벡터 1위는 유사도 0.8544짜리 **오답**, 정답은 2위(0.8172).
 *   재정렬이 브랜드 매칭으로 정답을 1위로 끌어올렸다.
 *
 * - 벡터 1위 기준으로 스킵을 판정하면: 0.8544 >= 0.82 → 검증 없이 오답 확정
 * - 재정렬 1위 기준만 보면: 재정렬이 0.82 넘는 후보를 끌어올렸을 때 검증 없이 확정
 * - 두 신호가 일치할 때만 스킵하면: 위 케이스는 불일치이므로 검증이 돌아 정답이 나온다
 *
 * 비용 영향은 작다. 정상 케이스(두 신호 일치)는 그대로 스킵되고, 불일치할 때만
 * Vision 호출이 1회 추가된다.
 */
export function shouldSkipVerification(vectorTop: Product, reordered: Product[]): boolean {
  const top = reordered[0];
  if (top.id !== vectorTop.id) return false;

  const similarity = top.similarity ?? 0;
  const second = reordered.length > 1 ? (reordered[1].similarity ?? 0) : 0;

  return (
    similarity >= HIGH_CONFIDENCE_SKIP_THRESHOLD ||
    (similarity >= 0.75 && similarity - second > 0.15)
  );
}

// ============================================
// 검색 단계 평가 (관리자용)
// ============================================

export interface SearchEvaluation {
  searchText: string;
  /** 벡터 검색 1위 제품명 */
  vectorTop: string | null;
  /** 정답의 벡터 검색 순위 (1부터, 후보에 없으면 null) */
  vectorRank: number | null;
  /** 재정렬 후 1위 제품명 */
  rerankedTop: string | null;
  /** 정답의 재정렬 후 순위 */
  rerankedRank: number | null;
  topSimilarity: number | null;
  /** 1위와 2위의 유사도 차 */
  similarityGap: number | null;
  /** 현재 임계값이라면 verifyMatch를 건너뛰는지 */
  wouldSkipVerification: boolean;
  candidateCount: number;
}

function findRank(candidates: Product[], expect: string): number | null {
  const needle = expect.toLowerCase();
  const index = candidates.findIndex(c =>
    c.reported_product_name.toLowerCase().includes(needle)
  );
  return index === -1 ? null : index + 1;
}

/**
 * 검색 단계만 실행해 진단 정보를 돌려준다. Vision 호출은 하지 않는다.
 *
 * 실제 파이프라인과 **같은 함수**(buildSearchText, vectorSearch,
 * prioritizeByMetadata)를 쓴다. 평가용으로 로직을 복제하면 복제본만 통과하고
 * 실제 경로는 깨지는 상황이 생기므로, 반드시 프로덕션 코드를 그대로 태운다.
 */
export async function evaluateSearch(
  env: Env,
  extracted: ExtractedLabelInfo,
  expect: string
): Promise<SearchEvaluation> {
  const searchText = buildSearchText(extracted);
  const embedding = await getEmbedding(env, searchText);
  const candidates = await vectorSearch(env, embedding, 50, 0.5, extracted.productType);

  if (candidates.length === 0) {
    return {
      searchText,
      vectorTop: null,
      vectorRank: null,
      rerankedTop: null,
      rerankedRank: null,
      topSimilarity: null,
      similarityGap: null,
      wouldSkipVerification: false,
      candidateCount: 0,
    };
  }

  const reordered = prioritizeByMetadata(candidates, extracted);
  const topSimilarity = reordered[0].similarity ?? 0;
  const secondSimilarity = reordered.length > 1 ? (reordered[1].similarity ?? 0) : 0;
  const similarityGap = topSimilarity - secondSimilarity;

  return {
    searchText,
    vectorTop: candidates[0].reported_product_name,
    vectorRank: findRank(candidates, expect),
    rerankedTop: reordered[0].reported_product_name,
    rerankedRank: findRank(reordered, expect),
    topSimilarity,
    similarityGap,
    // 파이프라인과 같은 함수를 쓴다. 조건을 복제하면 한쪽만 바뀌어 어긋난다.
    wouldSkipVerification: shouldSkipVerification(candidates[0], reordered),
    candidateCount: candidates.length,
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

/**
 * 일본 주류 회사명·와이너리명에 거의 항상 들어가는 일반 토큰.
 *
 * 단어 단위 매칭에 이런 토큰을 쓰면 무관한 양조장끼리 전부 점수를 주고받는다.
 * 2026-08-21 실측에서 `exporterEnglish`가 "Higashi Shuzo Co., Ltd."로 나왔을 때
 * "shuzo"(酒造 = 양조장)가 거의 모든 일본 양조장 이름에 걸려, `numbers`가 빈
 * 배열인데도 무관한 제품(마코토 쥰마이다이긴죠)이 1위로 올라왔다.
 */
const GENERIC_EXPORTER_TOKENS = new Set([
  'shuzo', 'shuzou', 'syuzo', 'jozo', 'jouzou', 'honten', 'seishu',
  'brewery', 'breweries', 'brewing', 'distillery', 'winery', 'wines', 'wine',
  'company', 'corp', 'corporation', 'kabushiki', 'kaisha', 'gaisha',
  'sake', 'shochu', 'japan', 'japanese', 'limited', 'holdings',
]);

/**
 * 양조장명에서 식별력 있는 단어만 남긴다.
 * 구두점으로도 쪼개서 "co.,"나 "ltd." 같은 형태를 걸러낸다.
 */
export function significantExporterWords(exporter: string): string[] {
  return exporter
    .split(/[\s,.()\-]+/)
    .filter(w => w.length > 3 && !GENERIC_EXPORTER_TOKENS.has(w));
}

/**
 * "이 후보가 맞다"는 실질 신호의 점수. 브랜드명과 양조장명만 본다.
 *
 * 이 값이 0이면 그 후보는 라벨과 아무 공통점이 없다는 뜻이므로, 숫자·지역·품종
 * 같은 보조 신호로 순위를 끌어올려서는 안 된다 (아래 호출부에서 게이트로 쓴다).
 */
export function scoreIdentity(
  productName: string,
  dbExporter: string,
  extracted: ExtractedLabelInfo
): number {
  let score = 0;

  // 브랜드명이 제품명에 들어 있는가.
  // DB 제품명은 "후쿠코마치 쥰마이 카라구치 (FUKUKOMACHI JUNMAI KARAKUCHI)" 형태로
  // 한글·영문을 모두 담고 있어 양쪽 표기가 다 매칭 대상이 된다.
  for (const brand of [extracted.brandEnglish, extracted.brandKorean]) {
    const b = (brand || '').toLowerCase().trim();
    if (b.length >= 2 && productName.includes(b)) {
      score += 100;
      break;
    }
  }

  const extractedExporter = (extracted.exporterEnglish || '').toLowerCase().trim();
  if (!extractedExporter) return score;

  // dbExporter가 빈 문자열일 때 `extractedExporter.includes('')`가 true가 되어
  // exporter 없는 행 전부에 80점이 붙던 버그를 막는다.
  if (dbExporter.length > 0) {
    if (dbExporter === extractedExporter) return score + 100;
    if (dbExporter.includes(extractedExporter) || extractedExporter.includes(dbExporter)) {
      return score + 80;
    }
  }

  if (productName.includes(extractedExporter)) return score + 60;

  const words = significantExporterWords(extractedExporter);
  const matched = words.filter(w => dbExporter.includes(w) || productName.includes(w));
  return score + matched.length * 20;
}

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
    const productName = c.reported_product_name.toLowerCase();
    const exporter = (c.exporter || '').toLowerCase();

    // 1단계: 실질 신호 (브랜드명 · 와이너리명)
    const identity = scoreIdentity(productName, exporter, extracted);
    let score = identity;

    // 2단계: 지역·품종·빈티지는 보조 신호다. 실질 신호가 없는 후보를
    // 단독으로 끌어올리면 무관한 제품이 1위가 된다 ("Malbec"이 같다는 이유로
    // 전혀 다른 와이너리의 와인이 올라오는 식).
    if (identity > 0) {
      if (extracted.region) {
        const region = extracted.region.toLowerCase();
        if (productName.includes(region) || exporter.includes(region)) score += 50;
      }

      if (extracted.grapeVariety) {
        const grape = extracted.grapeVariety.toLowerCase();
        if (productName.includes(grape) || exporter.includes(grape)) score += 50;
      }

      // 단어 경계 검사: "2018"이 "20180"에 걸리지 않도록.
      if (extracted.vintage && hasNumberMatch(productName, [extracted.vintage])) {
        score += 30;
      }
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
    const productName = c.reported_product_name.toLowerCase();
    const dbExporter = (c.exporter || '').toLowerCase();

    // 1단계: 실질 신호 (브랜드명 · 양조장명)
    const identity = scoreIdentity(productName, dbExporter, extracted);
    let score = identity;

    // 2단계: 숫자는 단독으로 후보를 끌어올리지 못한다.
    // 브랜드나 양조장이 이미 일치하는 후보들 사이에서 등급(정미비율 등)을
    // 가르는 용도로만 쓴다. 2026-08-21 실측에서 "精米歩合55%"의 "55"가
    // 무관한 제품 "하쿠로슈주 준마이 긴조 페어리 55"에 50점을 붙여 벡터가
    // 1위로 찾아둔 정답을 밀어냈다.
    if (identity > 0 && hasNumberMatch(productName, extracted.numbers)) {
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
