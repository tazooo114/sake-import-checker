import type { Env, EmbedQueueMessage } from '../types';
import { createClient } from '@supabase/supabase-js';
import { getBatchEmbeddings } from '../services/gemini';
import { logColo } from '../utils/colo';
import { logErrorAndNotify } from '../utils/logger';

/** Supabase UPDATE를 동시에 몇 건까지 보낼지. 큐 컨슈머의 서브리퀘스트 한도 안에서 여유롭다. */
const UPDATE_CONCURRENCY = 10;

/**
 * 임베딩 생성 큐 컨슈머.
 *
 * 업로드 HTTP 핸들러가 임베딩 없이 INSERT한 행들의 `name_embedding`을 채운다.
 * Gemini 호출을 여기서 하는 이유는 지역 차단 때문이다 — 자세한 근거는 utils/colo.ts 참고.
 *
 * **오류 분류를 하지 않는 이유**: 이 작업은 멱등하다(id로 UPDATE). 행은 이미 DB에
 * 안전하게 들어가 있고, 몇 번을 다시 돌려도 결과가 같다. 그래서 사진 큐처럼
 * "재시도 가능한 오류인가"를 판정할 필요 없이 무조건 retry하면 된다.
 * max_retries를 소진하면 DLQ로 가고, 그 행은 name_embedding이 NULL로 남아
 * /admin/embedding-status에서 드러난다.
 */
export async function handleEmbedQueue(
  batch: MessageBatch<EmbedQueueMessage>,
  env: Env
): Promise<void> {
  await logColo('queue/embed');

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

  for (const message of batch.messages) {
    const items = message.body?.items ?? [];

    if (items.length === 0) {
      message.ack();
      continue;
    }

    // 음수 id는 /admin/embed-selftest의 표식이다. BIGSERIAL은 1부터 시작하므로
    // 실제 데이터와 겹치지 않는다.
    const isSelfTest = items.every(item => item.id < 0);

    try {
      console.log(`[EMBED] Generating ${items.length} embeddings${isSelfTest ? ' (self-test)' : ''}`);

      const embeddings = await getBatchEmbeddings(env, items.map(i => i.text));

      if (embeddings.length !== items.length) {
        throw new Error(`임베딩 개수 불일치: ${embeddings.length} !== ${items.length}`);
      }

      let matched = 0;
      for (let i = 0; i < items.length; i += UPDATE_CONCURRENCY) {
        const slice = items.slice(i, i + UPDATE_CONCURRENCY);

        const results = await Promise.all(slice.map((item, j) =>
          supabase
            .from('sake_imports')
            .update({ name_embedding: embeddings[i + j] })
            .eq('id', item.id)
            .select('id')
        ));

        for (const result of results) {
          if (result.error) throw result.error;
          // 요청 건수가 아니라 **실제로 갱신된 행 수**를 센다. RETURNING이라
          // 추가 왕복이 없다. id가 어긋났다면 여기서 0이 나오므로,
          // "업로드는 성공했는데 검색이 안 된다"가 로그에서 바로 드러난다.
          matched += result.data?.length ?? 0;
        }
      }

      if (isSelfTest) {
        // /admin/embed-selftest는 존재하지 않는 id를 쓰므로 0건 갱신이 정상이다.
        // 여기서 경고를 내면 점검할 때마다 없는 문제를 조사하게 된다.
        console.log(`[EMBED] self-test OK — 큐 분기·Gemini·Supabase 경로 정상, DB 변경 없음`);
      } else {
        if (matched !== items.length) {
          // 데이터가 유실된 건 아니다 — 해당 행은 name_embedding이 NULL로 남고
          // /admin/embedding-status에 잡힌다. 다만 id 매칭이 틀렸다는 신호다.
          console.warn(`[EMBED] 갱신된 행 수 불일치: ${matched}/${items.length} — id 매칭 확인 필요`);
        }
        console.log(`[EMBED] Filled ${matched}/${items.length} embeddings`);
      }
      message.ack();
    } catch (error) {
      console.error(`[EMBED] Failed for ${items.length} rows (attempt ${message.attempts}):`, error);

      // 멱등하므로 무조건 재시도한다. 재시도는 새 컨슈머 실행이라
      // 지역 차단에 걸렸더라도 다른 colo를 잡을 수 있다.
      message.retry();

      // 마지막 시도까지 실패하면 DLQ로 넘어가므로 그때만 알린다.
      if (message.attempts >= 5) {
        await logErrorAndNotify(env, '[Embed Queue] 최종 실패, DLQ로 이동', error);
      }
    }
  }
}
