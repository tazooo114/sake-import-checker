import type { Context } from 'hono';
import type { Env, SearchEvalFixture } from '../types';

/**
 * 검색 평가를 큐에 넣는다.
 *
 * 여기서 바로 실행하지 않는 이유: Cloudflare Workers는 요청을 받은 엣지 위치에서
 * 외부 호출을 내보내는데, 관리자 HTTP 요청이 도달하는 위치에서는 Gemini 임베딩이
 * `User location is not supported`(400 FAILED_PRECONDITION)로 거절된다. 큐 컨슈머는
 * 사진 검색이 정상 동작하는 위치에서 실행되므로 그 경로를 재사용한다.
 *
 * 결과는 텔레그램(ADMIN_CHAT_ID 또는 body.chatId)과 `wrangler tail` 양쪽으로 나간다.
 */
export async function handleSearchEval(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${c.env.ADMIN_PASSWORD}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let fixtures: SearchEvalFixture[] | undefined;
  let chatId: number | undefined;

  try {
    const body = await c.req.json<{ fixtures?: SearchEvalFixture[]; chatId?: number }>();
    if (body?.fixtures?.length) fixtures = body.fixtures;
    if (typeof body?.chatId === 'number') chatId = body.chatId;
  } catch {
    // 본문 없음 — 저장소 픽스처를 쓰고 ADMIN_CHAT_ID로 보낸다.
  }

  if (!chatId && !c.env.ADMIN_CHAT_ID) {
    console.warn('[EVAL] ADMIN_CHAT_ID가 없어 결과는 로그로만 나갑니다.');
  }

  await c.env.PHOTO_QUEUE.send({ kind: 'search-eval', fixtures, chatId });

  return c.json({
    queued: true,
    fixtureSource: fixtures ? 'request' : 'repository',
    resultsVia: chatId || c.env.ADMIN_CHAT_ID ? 'telegram + wrangler tail' : 'wrangler tail',
  }, 202);
}
