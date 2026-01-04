import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env, Product, ProductCategory } from '../types';
import { logErrorAndNotify } from '../utils/logger';

const clients = new WeakMap<Env, SupabaseClient>();

export function getSupabaseClient(env: Env) {
  if (!clients.has(env)) {
    clients.set(env, createClient(env.SUPABASE_URL, env.SUPABASE_KEY));
  }
  return clients.get(env)!;
}

export async function vectorSearch(
  env: Env,
  embedding: number[],
  limit: number = 10,
  threshold: number = 0.5,
  categoryFilter?: ProductCategory  // NEW: optional category filter
): Promise<Product[]> {
  const supabase = getSupabaseClient(env);

  console.log('[DB] Calling search_products RPC with threshold:', threshold, 'category:', categoryFilter || 'all');

  const timeoutMs = 15000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Vector search timed out')), timeoutMs)
  );

  try {
    const { data, error } = await Promise.race([
      supabase.rpc('search_products', {
        query_embedding: embedding,
        match_count: limit,
        similarity_threshold: threshold,
        category_filter: categoryFilter || null,  // NEW: pass category filter
      }),
      timeoutPromise
    ]) as { data: Product[] | null, error: any };

    if (error) {
      await logErrorAndNotify(env, '[DB] Vector search error:', error.message);
      return [];
    }

    console.log('[DB] Search returned', data?.length || 0, 'results');
    return data || [];
  } catch (err) {
    await logErrorAndNotify(env, '[DB] Vector search exception:', err);
    return [];
  }
}

