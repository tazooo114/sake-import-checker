import type { ExtractedLabelInfo, SearchEvalFixture } from '../types';

/**
 * 검색 단계 평가용 픽스처.
 *
 * 왜 추출 JSON을 박아두는가 — Gemini 추출은 `temperature: 0`에서도 비결정적이라
 * 같은 사진에서 `exporterEnglish`가 `Higashi Shuzo` / `Higashi Shuzo Co., Ltd.`로
 * 갈린다. 사진부터 매번 돌리면 이 변동(유사도 0.09 수준)이 검색 로직 변경의
 * 효과(0.01~0.03 수준)를 덮어버려 측정이 성립하지 않는다.
 *
 * 반면 검색어 생성 → 임베딩 → 벡터검색 → 재정렬 구간은 완전히 결정론적이다.
 * 실측에서 같은 검색어가 유사도를 소수점 15자리까지 재현했다(0.819457612928652).
 * 그래서 추출 결과를 고정하면 검색 로직만 노이즈 없이 비교할 수 있다.
 *
 * 픽스처는 전부 2026-08-21 운영 로그(`wrangler tail`)에서 그대로 가져왔다.
 * 검색이 틀리는 사례를 만나면 그 추출 JSON을 여기 추가할 것 — 실패가 회귀
 * 테스트로 남는다.
 */
export type { SearchEvalFixture };

export const SEARCH_EVAL_FIXTURES: SearchEvalFixture[] = [
  {
    name: '克 新 無手勝流 (焼酎)',
    expect: '카츠 블루라벨',
    note: '정상 케이스. 라벨이 900ml이므로 900ml 행이 잡히는 것이 이상적이다.',
    extracted: {
      productType: 'Sake',
      brand: '克 新 無手勝流',
      brandKorean: '카츠 무테카츠류',
      brandEnglish: 'Katsu Mutekatsuryu',
      exporterEnglish: 'Higashi Shuzo',
      exporterOriginal: '東酒造株式会社',
      numbers: [],
      volume: '900ml',
      rawText: '克 新 無手勝流 KATSU MUTEKATSURYU 本格焼酎 東酒造株式会社',
      confidence: 80,
    },
  },
  {
    name: '克 新 無手勝流 (exporter에 법인격 포함)',
    expect: '카츠 블루라벨',
    note:
      '회귀: exporterEnglish가 "Higashi Shuzo Co., Ltd."로 나온 실측 변형. ' +
      '"shuzo"(酒造)가 거의 모든 일본 양조장에 걸려 무관한 제품(마코토 쥰마이다이긴죠)이 ' +
      '1위로 올라왔던 케이스.',
    extracted: {
      productType: 'Sake',
      brand: '克 新 無手勝流',
      brandKorean: '카츠 신 무테카츠류',
      brandEnglish: 'Katsu Mutekatsuryu',
      exporterEnglish: 'Higashi Shuzo Co., Ltd.',
      exporterOriginal: '東酒造株式会社',
      numbers: [],
      volume: '900ml',
      rawText: '克 新 無手勝流 本格焼酎 東酒造株式会社',
      confidence: 80,
    },
  },
  {
    name: '福小町 (정미보합 55%)',
    expect: '후쿠코마치',
    note:
      '회귀: numbers의 "55"(精米歩合)가 무관한 제품 "하쿠로슈주 준마이 긴조 페어리 55"에 ' +
      '50점을 붙여, 벡터가 1위로 찾아둔 정답을 재정렬이 밀어냈던 케이스.',
    extracted: {
      productType: 'Sake',
      brand: '福小町',
      brandKorean: '후쿠코마치',
      brandEnglish: 'Fukukomachi',
      exporterEnglish: 'Kimura Shuzo',
      exporterOriginal: '株式会社 木村酒造',
      numbers: ['25', '55', '75'],
      volume: '720ml',
      rawText: '福小町 秋田 木村 精米歩合55%',
      confidence: 80,
    },
  },
  {
    name: '福小町 (rawText가 길게 나온 변형)',
    expect: '후쿠코마치',
    note: '같은 사진에서 추출이 더 길게 나온 실측 변형. 추출 편차에 대한 내성 확인용.',
    extracted: {
      productType: 'Sake',
      brand: '福小町',
      brandKorean: '후쿠코마치',
      brandEnglish: 'Fukukomachi',
      exporterEnglish: 'Kimura Shuzo',
      exporterOriginal: '株式会社 木村酒造',
      numbers: ['25', '75', '55'],
      volume: '720ml',
      rawText: '福小町 創業元和 秋田木村 精米歩合55% 吟の精25% ぎんさん75% 株式会社 木村酒造',
      confidence: 80,
    },
  },
  {
    name: 'DEANDE Malbec 2023 (와인)',
    expect: '디안데',
    note:
      '회귀: 검색어에서 품종·지역을 빼면 무관한 "로센데"가 1위가 됐던 케이스. ' +
      'numbers에 바코드 조각(71570-084, 71000)이 섞여 들어오는 사례이기도 하다.',
    extracted: {
      productType: 'Wine',
      brand: 'DEANDE',
      brandKorean: '데안데',
      brandEnglish: 'DEANDE',
      exporterEnglish: 'DEANDE',
      exporterOriginal: 'DEANDE',
      numbers: ['2023', '71570-084', '71000'],
      volume: '750ml',
      rawText:
        'DEANDE MALBEC 2023 MENDOZA | ARGENTINA A classic Malbec from the high plateaus and valleys of Mendoza.',
      region: 'Mendoza, Argentina',
      grapeVariety: 'Malbec',
      vintage: '2023',
      confidence: 80,
    },
  },
];

/** 픽스처의 부분 지정을 완전한 ExtractedLabelInfo로 채운다. */
export function toExtractedLabelInfo(
  partial: SearchEvalFixture['extracted']
): ExtractedLabelInfo {
  return {
    brand: '',
    brandKorean: '',
    brandEnglish: '',
    exporterEnglish: '',
    exporterOriginal: '',
    numbers: [],
    volume: '',
    rawText: '',
    confidence: 80,
    ...partial,
  };
}
