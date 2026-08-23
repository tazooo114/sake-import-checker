import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import type { QueueMessage, EmbedQueueMessage } from './types';
import { handleTelegramWebhook, handleSetWebhook } from './handlers/telegram';
import {
  handleInitUpload,
  handleUploadChunk,
  handleStats,
  handleColoProbe,
  handleEmbeddingStatus,
  handleEmbedSelfTest,
} from './handlers/admin';
import { handleHealth } from './handlers/health';
import { handleSearchEval } from './handlers/eval';
import { handlePhotoQueue } from './handlers/queueConsumer';
import { handleEmbedQueue } from './handlers/embedQueue';

/** wrangler.toml의 [[queues.consumers]] queue 값과 반드시 일치해야 한다. */
const EMBED_QUEUE_NAME = 'embedding-queue';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: (origin) => {
    if (!origin || origin.endsWith('.pages.dev') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return origin || '*';
    }
    return null;
  },
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.get('/health', handleHealth);
app.post('/telegram-webhook', handleTelegramWebhook);
app.post('/admin/upload-init', handleInitUpload);
app.post('/admin/upload-chunk', handleUploadChunk);
app.get('/admin/stats', handleStats);
app.get('/admin/colo-probe', handleColoProbe);
app.get('/admin/embedding-status', handleEmbeddingStatus);
app.post('/admin/embed-selftest', handleEmbedSelfTest);
app.post('/admin/set-webhook', handleSetWebhook);
app.post('/admin/eval', handleSearchEval);

app.notFound((c) => c.json({ error: 'Not Found' }, 404));
app.onError((err, c) => {
  console.error('[ERROR]', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default {
  fetch: app.fetch,

  // Cron Trigger Handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    switch (event.cron) {
      case '0 */6 * * *':
        console.log('[CRON] Triggered keepalive task');
        const { handleKeepAlive } = await import('./cron/keepalive');
        ctx.waitUntil(handleKeepAlive(env));
        break;
      default:
        console.log('[CRON] Unknown schedule:', event.cron);
        if (event.cron === '0 12 * * *') {
          console.log('[CRON] Triggered legacy keepalive task');
          const { handleKeepAlive } = await import('./cron/keepalive');
          ctx.waitUntil(handleKeepAlive(env));
        }
    }
  },

  // Queue Consumer Handler
  // 큐가 둘이므로 batch.queue로 분기한다.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === EMBED_QUEUE_NAME) {
      await handleEmbedQueue(batch as MessageBatch<EmbedQueueMessage>, env);
      return;
    }

    await handlePhotoQueue(batch as MessageBatch<QueueMessage>, env);
  },
};
