import { createClient } from '@supabase/supabase-js';
import type { Env } from '../types';

export async function handleKeepAlive(env: Env) {
    console.log('[CRON_KEEPALIVE] Starting keepalive check...');
    try {
        const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

        // Simple query to keep the database active
        const { count, error } = await supabase
            .from('sake_imports')
            .select('*', { count: 'exact', head: true })
            .limit(1);

        if (error) {
            console.error('[CRON_KEEPALIVE] Supabase Error:', JSON.stringify(error));
            throw error;
        }

        console.log(`[CRON_KEEPALIVE] Success. Active rows: ${count}. Database is active.`);
        return;
    } catch (err) {
        console.error('[CRON_KEEPALIVE] Unexpected error:', err);
        throw err;
    }
}
