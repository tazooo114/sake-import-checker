import type { Context } from 'hono';
import type { Env, TelegramUpdate, TelegramMessage, TelegramPhotoSize } from '../types';
import { sendMessage, getFileUrl } from '../services/telegram';

export async function handleTelegramWebhook(c: Context<{ Bindings: Env }>) {
  try {
    const update: TelegramUpdate = await c.req.json();

    if (update.message?.photo) {
      c.executionCtx.waitUntil(handlePhotoMessage(c.env, update.message));
    } else if (update.message?.text) {
      c.executionCtx.waitUntil(handleTextMessage(c.env, update.message));
    }

    return c.json({ ok: true });
  } catch (error) {
    console.error('[TELEGRAM_WEBHOOK_ERROR]', error);
    return c.json({ ok: true });
  }
}

async function handlePhotoMessage(env: Env, message: TelegramMessage) {
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const photos = message.photo;

  if (!photos || photos.length === 0) {
    return;
  }

  const MAX_FILE_SIZE = 5 * 1024 * 1024;
  let targetPhoto: TelegramPhotoSize | undefined;

  for (let i = photos.length - 1; i >= 0; i--) {
    const p = photos[i];
    if (!p.file_size || p.file_size <= MAX_FILE_SIZE) {
      targetPhoto = p;
      break;
    }
  }

  if (!targetPhoto) {
    targetPhoto = photos[0];
  }

  // 분석 시작 메시지를 먼저 보냄 (사용자 즉시 피드백)
  await sendMessage(env, chatId, '라벨을 분석하고 있습니다... 🔍', { reply_to_message_id: messageId });

  // 큐에 enqueue → consumer가 순차적으로 처리 (Rate limit 방지)
  await env.PHOTO_QUEUE.send({
    chatId,
    messageId,
    fileId: targetPhoto.file_id,
  });
}


async function handleTextMessage(env: Env, message: TelegramMessage) {
  const chatId = message.chat.id;
  const text = message.text || '';

  if (text === '/start') {
    const welcomeMessage = `
주류 수입 검색 봇입니다. 🍶🍷

사용 방법:
1. 사케 또는 와인 병 라벨 사진을 보내주세요.
2. 해당 제품의 수입 정보를 알려드립니다.
   • 사케: 양조장(제조사), 수입사, 수입 규모
   • 와인: 와이너리, 수입사, 수입 규모

💡 팁:
- 라벨 글자가 잘 보이게 찍어주세요.
- 사진 용량이 너무 크면 자동으로 최적화된 크기로 처리됩니다.
    `.trim();
    await sendMessage(env, chatId, welcomeMessage);
    return;
  }

  await sendMessage(env, chatId, '사진을 보내주세요 📸');
}
