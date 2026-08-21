import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import type { PhotoQueueMessage } from './types';
import { handleTelegramWebhook, handleSetWebhook } from './handlers/telegram';
import { handleInitUpload, handleUploadChunk, handleStats } from './handlers/admin';
import { handleHealth } from './handlers/health';
import { handlePhotoQueue } from './handlers/queueConsumer';

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
app.post('/admin/set-webhook', handleSetWebhook);

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

  // Queue Consumer Handler (사진 순차 처리)
  async queue(batch: MessageBatch<PhotoQueueMessage>, env: Env): Promise<void> {
    await handlePhotoQueue(batch, env);
  },
};
