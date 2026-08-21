import type { Env, SearchEvalFixture } from '../types';
import { evaluateSearch } from './search';
import { SEARCH_EVAL_FIXTURES, toExtractedLabelInfo } from '../fixtures/searchEval';

interface EvalRow {
  name: string;
  expect: string;
  pass: boolean;
  rerankHurt: boolean;
  vectorRank: number | null;
  rerankedRank: number | null;
  rerankedTop: string | null;
  topSimilarity: number | null;
  similarityGap: number | null;
  wouldSkipVerification: boolean;
  error?: string;
}

export async function runSearchEval(
  env: Env,
  fixtures: SearchEvalFixture[] = SEARCH_EVAL_FIXTURES
): Promise<{ total: number; passed: number; rows: EvalRow[] }> {
  const rows: EvalRow[] = [];

  for (const fixture of fixtures) {
    try {
      const e = await evaluateSearch(
        env,
        toExtractedLabelInfo(fixture.extracted),
        fixture.expect
      );

      rows.push({
        name: fixture.name,
        expect: fixture.expect,
        pass: e.rerankedRank === 1,
        // 벡터는 정답을 잘 찾았는데 재정렬이 끌어내렸는가.
        // true면 재정렬이 해를 끼친 것이다 — 오늘 두 번 난 사고의 형태.
        rerankHurt:
          e.vectorRank !== null &&
          e.rerankedRank !== null &&
          e.rerankedRank > e.vectorRank,
        vectorRank: e.vectorRank,
        rerankedRank: e.rerankedRank,
        rerankedTop: e.rerankedTop,
        topSimilarity: e.topSimilarity,
        similarityGap: e.similarityGap,
        wouldSkipVerification: e.wouldSkipVerification,
      });
    } catch (error) {
      rows.push({
        name: fixture.name,
        expect: fixture.expect,
        pass: false,
        rerankHurt: false,
        vectorRank: null,
        rerankedRank: null,
        rerankedTop: null,
        topSimilarity: null,
        similarityGap: null,
        wouldSkipVerification: false,
        error: String(error),
      });
    }
  }

  return { total: rows.length, passed: rows.filter(r => r.pass).length, rows };
}

/** 텔레그램으로 보낼 요약. HTML parse_mode 기준. */
export function formatEvalReport(result: { total: number; passed: number; rows: EvalRow[] }): string {
  const lines: string[] = [
    `<b>검색 평가 ${result.passed}/${result.total} 통과</b>`,
    '',
  ];

  for (const r of result.rows) {
    lines.push(`${r.pass ? '✅' : '❌'} ${r.name}`);

    if (r.error) {
      lines.push(`   오류: ${r.error.slice(0, 150)}`);
      lines.push('');
      continue;
    }

    lines.push(`   기대: ${r.expect} / 1위: ${r.rerankedTop ?? '없음'}`);
    lines.push(`   순위: 벡터 ${r.vectorRank ?? '-'} → 재정렬 ${r.rerankedRank ?? '-'}`);
    lines.push(
      `   유사도 ${r.topSimilarity?.toFixed(4) ?? '-'} (gap ${r.similarityGap?.toFixed(4) ?? '-'})` +
      `${r.wouldSkipVerification ? ' · 검증스킵' : ''}`
    );
    if (r.rerankHurt) {
      lines.push('   ⚠️ 재정렬이 정답을 끌어내렸습니다');
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
