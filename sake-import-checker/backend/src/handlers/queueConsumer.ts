import type { Env, QueueMessage } from '../types';
import { isEvalMessage } from '../types';
import { searchProduct } from '../services/search';
import { sendMessage, getFileUrl } from '../services/telegram';
import { formatSearchResult } from '../utils/formatter';
import { logErrorAndNotify } from '../utils/logger';
import { runSearchEval, formatEvalReport } from '../services/evalRunner';

// ============================================
// Cloudflare Queue Consumer
// 사진 처리를 1장씩 순차적으로 수행
// max_batch_size = 1 이므로 항상 messages.length === 1
// ============================================
export async function handlePhotoQueue(
    batch: MessageBatch<QueueMessage>,
    env: Env
): Promise<void> {
    for (const message of batch.messages) {
        // 검색 평가는 임베딩 API를 쓰는데, 관리자 HTTP 요청이 도달하는 엣지 위치에서는
        // Gemini가 'User location is not supported'로 거절한다. 사진 검색이 정상 동작하는
        // 이 큐 컨슈머 위치를 그대로 재사용한다.
        if (isEvalMessage(message.body)) {
            const target = message.body.chatId ?? Number(env.ADMIN_CHAT_ID);

            try {
                console.log('[QUEUE] Running search evaluation');
                const result = await runSearchEval(env, message.body.fixtures);

                console.log(`[EVAL] ${result.passed}/${result.total} passed`);
                for (const row of result.rows) {
                    console.log(
                        `[EVAL] ${row.pass ? 'PASS' : 'FAIL'} ${row.name} — ` +
                        `vector ${row.vectorRank} → reranked ${row.rerankedRank} ` +
                        `sim ${row.topSimilarity?.toFixed(4) ?? '-'} gap ${row.similarityGap?.toFixed(4) ?? '-'}` +
                        `${row.rerankHurt ? ' (RERANK HURT)' : ''}` +
                        `${row.error ? ' ERROR: ' + row.error.slice(0, 120) : ''}`
                    );
                }

                if (Number.isFinite(target) && target !== 0) {
                    await sendMessage(env, target, formatEvalReport(result)).catch(() => { });
                }
            } catch (error) {
                console.error('[EVAL] Evaluation failed:', error);
                await logErrorAndNotify(env, '[Eval]', error);
            }

            message.ack();
            continue;
        }

        const { chatId, messageId, fileId } = message.body;

        try {
            console.log(`[QUEUE] Processing photo for chat ${chatId}, message ${messageId}`);

            const fileUrl = await getFileUrl(env, fileId);
            const result = await searchProduct(env, fileUrl);
            const responseText = formatSearchResult(result);

            await sendMessage(env, chatId, responseText, { reply_to_message_id: messageId });

            // 처리 성공 → 메시지 ACK (자동이지만 명시적으로)
            message.ack();

            console.log(`[QUEUE] Successfully processed photo for chat ${chatId}`);
        } catch (error) {
            console.error(`[QUEUE] Failed to process photo for chat ${chatId}:`, error);

            // 재시도 가능한 에러면 retry, 아니면 ack로 DLQ 방지
            const errorStr = String(error);
            const isRetryable = errorStr.includes('429') || errorStr.includes('timeout') || errorStr.includes('network');

            if (isRetryable) {
                // 재시도 허용 (wrangler.toml max_retries = 3)
                message.retry();
                console.log(`[QUEUE] Message requeued for retry (retryable error)`);
            } else {
                // 재시도 불가 에러 → 사용자에게 에러 메시지 발송 후 ACK
                await sendMessage(
                    env,
                    chatId,
                    '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
                    { reply_to_message_id: messageId }
                ).catch(() => { }); // 에러 메시지 전송 실패해도 무시

                await logErrorAndNotify(env, '[Queue Consumer]', error);
                message.ack();
            }
        }
    }
}
