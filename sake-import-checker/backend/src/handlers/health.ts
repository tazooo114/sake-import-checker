import type { Context } from 'hono';
import type { Env } from '../types';
import { logColo } from '../utils/colo';

export async function handleHealth(c: Context<{ Bindings: Env }>) {
  // 실행 PoP 진단(임시). 관리자 HTTP 경로가 어느 데이터센터에서 도는지 확인한다.
  const ingress = (c.req.raw as any).cf?.colo as string | undefined;
  const colo = await logColo('http/health', ingress);

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT || 'development',
    version: '1.0.0',
    colo
  });
}
