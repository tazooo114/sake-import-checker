import type { Env, TelegramFile } from '../types';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  options?: { reply_to_message_id?: number }
): Promise<void> {
  const url = `${TELEGRAM_API_BASE}${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_to_message_id: options?.reply_to_message_id,
      parse_mode: 'HTML',
    }),
  });
}

/**
 * 웹훅 URL과 secret_token을 Telegram에 등록한다.
 *
 * secret_token을 넘기면 Telegram이 이후 모든 웹훅 요청에
 * X-Telegram-Bot-Api-Secret-Token 헤더를 실어 보낸다.
 */
export async function setWebhook(
  env: Env,
  url: string,
  secretToken: string
): Promise<{ ok: boolean; description?: string }> {
  const response = await fetch(`${TELEGRAM_API_BASE}${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secretToken }),
  });

  return await response.json() as { ok: boolean; description?: string };
}

export async function getFileUrl(env: Env, fileId: string): Promise<string> {
  const url = `${TELEGRAM_API_BASE}${env.TELEGRAM_BOT_TOKEN}/getFile`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  const data = await response.json() as { ok: boolean; result: TelegramFile };

  if (!data.ok || !data.result.file_path) {
    throw new Error('Failed to get file path');
  }

  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

export async function notifyAdmin(env: Env, message: string): Promise<void> {
  if (!env.ADMIN_CHAT_ID) {
    return;
  }

  const chatId = parseInt(env.ADMIN_CHAT_ID, 10);
  if (isNaN(chatId)) {
    return;
  }

  await sendMessage(env, chatId, `⚠️ ${message}`);
}
