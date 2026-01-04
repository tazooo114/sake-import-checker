import { describe, it, expect, vi } from 'vitest';

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
