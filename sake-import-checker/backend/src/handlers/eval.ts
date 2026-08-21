import type { Context } from 'hono';
import type { Env } from '../types';
import { evaluateSearch } from '../services/search';
import {
  SEARCH_EVAL_FIXTURES,
  toExtractedLabelInfo,
  type SearchEvalFixture,
} from '../fixtures/searchEval';

/**
 * 검색 단계 평가를 돌리고 결과 표를 반환한다.
 *
 * Vision 호출이 없으므로 비용은 픽스처당 임베딩 1회 + DB 조회 1회다.
 * 임계값이나 재정렬 로직을 건드린 뒤 배포하고 이걸 한 번 치면, 사진을 찍어
 * 보내지 않고도 회귀 여부를 알 수 있다.
 *
 * body에 fixtures를 실어 보내면 저장소 픽스처 대신 그것으로 돌린다.
 * 새 실패 사례를 코드에 넣기 전에 즉석에서 확인할 때 쓴다.
 */
export async function handleSearchEval(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${c.env.ADMIN_PASSWORD}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let fixtures: SearchEvalFixture[] = SEARCH_EVAL_FIXTURES;
  let source = 'repository';

  try {
    const body = await c.req.json<{ fixtures?: SearchEvalFixture[] }>();
    if (body?.fixtures?.length) {
      fixtures = body.fixtures;
      source = 'request';
    }
  } catch {
    // 본문 없음 — 저장소 픽스처를 쓴다.
  }

  const results = [];

  for (const fixture of fixtures) {
    try {
      const evaluation = await evaluateSearch(
        c.env,
        toExtractedLabelInfo(fixture.extracted),
        fixture.expect
      );

      results.push({
        name: fixture.name,
        expect: fixture.expect,
        note: fixture.note,
        pass: evaluation.rerankedRank === 1,
        // 재정렬이 정답을 끌어내렸는지. 이 값이 true면 재정렬이 해를 끼친 것이다.
        rerankHurt:
          evaluation.vectorRank !== null &&
          evaluation.rerankedRank !== null &&
          evaluation.rerankedRank > evaluation.vectorRank,
        ...evaluation,
      });
    } catch (error) {
      results.push({
        name: fixture.name,
        expect: fixture.expect,
        pass: false,
        error: String(error),
      });
    }
  }

  const passed = results.filter(r => r.pass).length;

  return c.json({
    source,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  });
}
