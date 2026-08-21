import { describe, it, expect, vi } from 'vitest';
import {
  isExtractionUsable,
  meaningfulNumbers,
  hasNumberMatch,
  significantExporterWords,
  scoreIdentity,
} from './search';
import type { ExtractedLabelInfo } from '../types';

const mockEnv = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  GEMINI_API_KEY: 'test-gemini-key',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_KEY: 'test-supabase-key',
  ADMIN_PASSWORD: 'test-password',
  ENVIRONMENT: 'test',
};

describe('Search Service', () => {
  it('should parse volume correctly', () => {
    const parseVolume = (volumeStr: string): number | null => {
      const mlMatch = volumeStr.match(/(\d+)\s*ml/i);
      if (mlMatch) {
        return parseInt(mlMatch[1], 10);
      }

      const literMatch = volumeStr.match(/(\d+(?:\.\d+)?)\s*[lL리터]/);
      if (literMatch) {
        return parseFloat(literMatch[1]) * 1000;
      }

      return null;
    };

    expect(parseVolume('720ml')).toBe(720);
    expect(parseVolume('1800ml')).toBe(1800);
    expect(parseVolume('1.8L')).toBe(1800);
    expect(parseVolume('1.8리터')).toBe(1800);
    expect(parseVolume('unknown')).toBe(null);
  });

  it('should filter candidates by numbers', () => {
    const candidates = [
      { reported_product_name: '닷사이 23 준마이다이긴조', volume: 720 },
      { reported_product_name: '닷사이 39 준마이다이긴조', volume: 720 },
      { reported_product_name: '닷사이 45 준마이다이긴조', volume: 720 },
    ];

    const extractedNumbers = ['39'];

    const filtered = candidates.filter((c) => {
      const productName = c.reported_product_name.toLowerCase();
      return extractedNumbers.some((num) => productName.includes(num));
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0].reported_product_name).toContain('39');
  });

  it('should filter candidates by volume', () => {
    const candidates = [
      { reported_product_name: '닷사이 39', volume: 720 },
      { reported_product_name: '닷사이 39', volume: 1800 },
    ];

    const targetVolume = 720;

    const filtered = candidates.filter((c) => {
      if (!c.volume) return false;
      return Math.abs(c.volume - targetVolume) < 100;
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0].volume).toBe(720);
  });
});

describe('Metadata identity scoring', () => {
  function extraction(overrides: Partial<ExtractedLabelInfo> = {}): ExtractedLabelInfo {
    return {
      productType: 'Sake', brand: '', brandKorean: '', brandEnglish: '',
      exporterEnglish: '', exporterOriginal: '', numbers: [], volume: '',
      rawText: '', confidence: 80, ...overrides,
    };
  }

  it('drops generic brewery tokens from word-level matching', () => {
    // "shuzo"(酒造)는 거의 모든 일본 양조장 이름에 들어가 식별력이 없다.
    expect(significantExporterWords('higashi shuzo co., ltd.')).toEqual(['higashi']);
    expect(significantExporterWords('kimura shuzo')).toEqual(['kimura']);
  });

  // 회귀: exporterEnglish가 "Higashi Shuzo Co., Ltd."였을 때 "shuzo"가
  // 무관한 양조장에 걸려 마코토 쥰마이다이긴죠가 1위로 올라왔다.
  it('gives no identity score to an unrelated product sharing only a generic token', () => {
    const label = extraction({
      brandKorean: '카츠 신 무테카츠류',
      brandEnglish: 'Katsu Mutekatsuryu',
      exporterEnglish: 'Higashi Shuzo Co., Ltd.',
    });

    expect(scoreIdentity('마코토 쥰마이다이긴죠 (makoto junmaidaiginjo)', 'makoto shuzo', label)).toBe(0);
  });

  it('scores the correct product via brand name in either script', () => {
    const label = extraction({
      brandKorean: '후쿠코마치',
      brandEnglish: 'Fukukomachi',
      exporterEnglish: 'Kimura Shuzo',
    });

    expect(
      scoreIdentity('후쿠코마치 쥰마이 카라구치 (fukukomachi junmai karakuchi)', '', label)
    ).toBeGreaterThanOrEqual(100);
  });

  // 회귀: dbExporter가 ''일 때 extractedExporter.includes('')가 true라서
  // exporter 없는 행 전부에 80점이 붙었다.
  it('does not score an empty DB exporter as a partial match', () => {
    const label = extraction({ exporterEnglish: 'Kimura Shuzo' });
    expect(scoreIdentity('전혀 다른 제품', '', label)).toBe(0);
  });

  it('scores an exact exporter match highest', () => {
    const label = extraction({ exporterEnglish: 'Kimura Shuzo' });
    expect(scoreIdentity('아무 제품', 'kimura shuzo', label)).toBe(100);
  });
});

describe('Number matching', () => {
  // 2026-08-21 운영 로그에서 실제로 추출된 numbers (焼酎 라벨 1장).
  // 도수, 용량, 주소 번지, 전화번호 조각, 관리번호가 전부 섞여 있었다.
  const REAL_NOISY_NUMBERS = ['25', '900', '1', '37', '1', '099', '268', '2020', '251714'];

  it('drops single-digit numbers', () => {
    // "1"은 이름에 1이 들어간 거의 모든 제품에 매칭되어 재정렬을 무작위로 만든다.
    expect(meaningfulNumbers(['1', '7', '23'])).toEqual(['23']);
  });

  it('drops volume-like numbers', () => {
    expect(meaningfulNumbers(['720', '1800', '750', '900'])).toEqual([]);
  });

  it('keeps grade numbers used in sake product names', () => {
    expect(meaningfulNumbers(['23', '39', '45'])).toEqual(['23', '39', '45']);
  });

  it('drops non-numeric strings', () => {
    expect(meaningfulNumbers(['23도', 'ABC', '', '2 3'])).toEqual([]);
  });

  it('filters the real noisy extraction down to identifying numbers', () => {
    // 도수 25와 전화번호 조각 099/268은 프롬프트 수정으로 걸러지길 기대하지만,
    // 코드 단에서는 자릿수 규칙만으로 거를 수 있는 것까지만 처리한다.
    expect(meaningfulNumbers(REAL_NOISY_NUMBERS)).not.toContain('1');
    expect(meaningfulNumbers(REAL_NOISY_NUMBERS)).not.toContain('900');
  });

  it('does not match a number embedded in a longer number', () => {
    // 회귀: 기존 includes()는 "23"을 "2023 빈티지"에 매칭시켰다.
    expect(hasNumberMatch('닷사이 2023 빈티지', ['23'])).toBe(false);
    expect(hasNumberMatch('샤또 20180', ['2018'])).toBe(false);
  });

  it('matches a number that stands alone in the product name', () => {
    expect(hasNumberMatch('닷사이 23 준마이다이긴조', ['23'])).toBe(true);
    expect(hasNumberMatch('닷사이 39 준마이다이긴조', ['39', '45'])).toBe(true);
  });

  it('returns false when every extracted number was filtered out', () => {
    expect(hasNumberMatch('이모쇼츄 카츠 블루라벨(900ml)', ['1', '900'])).toBe(false);
  });

  it('returns false for an empty numbers array', () => {
    expect(hasNumberMatch('닷사이 23', [])).toBe(false);
  });
});

describe('isExtractionUsable', () => {
  function makeExtraction(overrides: Partial<ExtractedLabelInfo> = {}): ExtractedLabelInfo {
    return {
      productType: 'Sake',
      brand: '獺祭',
      brandKorean: '닷사이',
      brandEnglish: 'Dassai',
      exporterEnglish: 'Asahi Shuzo',
      exporterOriginal: '旭酒造',
      numbers: ['23'],
      volume: '720ml',
      rawText: '獺祭 純米大吟醸 二割三分 720ml',
      confidence: 80,
      ...overrides,
    };
  }

  it('accepts a normal extraction', () => {
    expect(isExtractionUsable(makeExtraction())).toBe(true);
  });

  // 회귀 테스트: 이 케이스가 예전에 가드를 통과해 에러 문자열이 임베딩됐다.
  it('rejects a failed extraction even if rawText is non-empty', () => {
    const failed = makeExtraction({
      brand: '',
      rawText: 'Error: Timeout after 20000ms',
      confidence: 0,
      errorType: 'EXTRACTION_FAILED',
    });

    expect(isExtractionUsable(failed)).toBe(false);
  });

  it('rejects rate-limited and parse-failed extractions', () => {
    expect(isExtractionUsable(makeExtraction({ confidence: 0, errorType: 'RATE_LIMIT' }))).toBe(false);
    expect(isExtractionUsable(makeExtraction({ confidence: 0, errorType: 'PARSE_FAILED' }))).toBe(false);
  });

  // errorType 없이 confidence만 0인 결과가 생겨도 검색으로 새지 않아야 한다.
  it('rejects zero-confidence extractions without an errorType', () => {
    expect(isExtractionUsable(makeExtraction({ confidence: 0 }))).toBe(false);
  });

  it('rejects an extraction with neither rawText nor brand', () => {
    // Gemini가 정상 JSON을 반환했지만 전 필드가 빈 경우 (confidence 50)
    expect(isExtractionUsable(makeExtraction({ brand: '', rawText: '', confidence: 50 }))).toBe(false);
  });

  it('accepts an extraction that has rawText but no brand', () => {
    expect(isExtractionUsable(makeExtraction({ brand: '', confidence: 50 }))).toBe(true);
  });
});

describe('Exporter Prioritization', () => {
  // Simulate the exporter matching scoring logic from prioritizeSakeByMetadata
  function scoreExporter(dbExporter: string, extractedExporter: string): number {
    const db = dbExporter.toLowerCase();
    const extracted = extractedExporter.toLowerCase();
    if (db === extracted) return 100;
    if (db.includes(extracted) || extracted.includes(db)) return 80;
    const words = extracted.split(/\s+/).filter(w => w.length > 3);
    const matched = words.filter(w => db.includes(w));
    return matched.length * 20;
  }

  it('should give full score for exact exporter match', () => {
    expect(scoreExporter('Higashi Shuzo', 'Higashi Shuzo')).toBe(100);
  });

  it('should give partial score when extracted exporter is substring of DB exporter', () => {
    // "Higashi Shuzo" ⊂ "KINPO FACTORY HIGASHI SHUZO"
    expect(scoreExporter('KINPO FACTORY HIGASHI SHUZO', 'Higashi Shuzo')).toBe(80);
  });

  it('should give partial score when DB exporter is substring of extracted exporter', () => {
    expect(scoreExporter('Higashi Shuzo', 'Kinpo Factory Higashi Shuzo')).toBe(80);
  });

  it('should give word-level score for partial word match', () => {
    // "Higashi" (length 7 > 3) matches
    const score = scoreExporter('HIGASHI BREWERY CO', 'Higashi Shuzo');
    expect(score).toBeGreaterThan(0);
    expect(score).toBe(20); // 1 word matched ("higashi")
  });

  it('should give 0 score for completely unrelated exporters', () => {
    // "Penfolds" vs "Chateau Margaux" - no common significant words
    expect(scoreExporter('Penfolds Winery', 'Chateau Margaux')).toBe(0);
  });
});


describe('Formatter', () => {
  it('should format found product correctly', () => {
    const product = {
      id: 1,
      reported_product_name: '닷사이 39 준마이다이긴조',
      category: '사케',
      exporter: 'ABC Trading',
      origin_country: 'Japan',
      raw_importer_name: 'XYZ Import',
      value: 50000,
      volume: 720,
      unit_price: 69.44,
    };

    const lines = [
      `<b>${product.reported_product_name}</b>`,
      '',
      `수입사: ${product.exporter}`,
      `카테고리: ${product.category}`,
      `용량: ${product.volume}ml`,
      `최고가: $${product.value.toLocaleString()}`,
    ];

    const result = lines.join('\n');

    expect(result).toContain('닷사이 39');
    expect(result).toContain('ABC Trading');
    expect(result).toContain('720ml');
  });
});
