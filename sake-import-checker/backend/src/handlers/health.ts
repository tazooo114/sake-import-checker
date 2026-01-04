import type { Context } from 'hono';
import type { Env } from '../types';

export async function handleHealth(c: Context<{ Bindings: Env }>) {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT || 'development',
    version: '1.0.0'
  });
}
