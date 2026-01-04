import type { Env } from '../types';
import { notifyAdmin } from '../services/telegram';

/**
 * 에러를 콘솔에 기록하고 관리자에게 텔레그램 알림을 전송하는 통합 함수
 * @param env Cloudflare Env
 * @param context 에러가 발생한 위치/맥락 (예: '[Search]', '[Gemini]')
 * @param error 발생한 에러 객체 또는 메시지
 * @param notify 관리자 알림 전송 여부 (기본값: true)
 */
export async function logErrorAndNotify(
  env: Env, 
  context: string, 
  error: any, 
  notify: boolean = true
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const fullMessage = `${context} ${errorMessage}`;
  
  // 1. 콘솔 로그 (Cloudflare Logs)
  console.error(fullMessage, error);

  // 2. 관리자 알림 (Telegram)
  if (notify) {
    try {
      await notifyAdmin(env, `🚨 Error ${context}\n${errorMessage}`);
    } catch (notifyError) {
      console.error('[Logger] Failed to send admin notification:', notifyError);
    }
  }
}
