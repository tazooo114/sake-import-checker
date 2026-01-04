import type { Context } from 'hono';
import type { Env, ExcelRow, ProductCategory } from '../types';
import { createClient } from '@supabase/supabase-js';
import { getBatchEmbeddings } from '../services/gemini';

// ============================================
// Retry Helper with Exponential Backoff
// ============================================
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry non-recoverable errors
      if (error && typeof error === 'object' && 'message' in error) {
        const msg = String(error.message).toLowerCase();

        // Auth/validation errors - fail immediately
        if (msg.includes('unauthorized') ||
            msg.includes('invalid') ||
            msg.includes('forbidden')) {
          throw error;
        }
      }

      // Last attempt - throw error
      if (attempt === maxRetries - 1) {
        console.error(`[RETRY] All ${maxRetries} attempts failed`);
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s...
      const delay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * 500; // Add 0-500ms random jitter
      const totalDelay = delay + jitter;

      console.log(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${Math.round(totalDelay)}ms...`);
      console.log(`[RETRY] Error:`, error);

      await new Promise(resolve => setTimeout(resolve, totalDelay));
    }
  }

  throw lastError;
}

// ============================================
// Category + HS-CODE Categorization
// ============================================
function getCategoryFromExcelData(row: ExcelRow): ProductCategory {
  const category = row['Category'];
  const hsCode = String(row['HS-CODE'] || '').trim();

  // Primary categorization by Korean category name
  if (category === '과실주') return 'Wine';
  if (category === '청주') return 'Sake';
  if (category === '소주' || category === '일반증류주') return 'Spirits';

  // Sub-categorization for ambiguous categories (기타주류, 리큐르)
  if (category === '기타주류' || category === '리큐르') {
    if (hsCode.startsWith('2204')) return 'Etc-Wine';    // Wine-like
    if (hsCode.startsWith('2206')) return 'Etc-Sake';    // Sake-like
    if (hsCode.startsWith('2208')) return 'Etc-Spirits'; // Spirits-like
    return 'Other';  // Unclassified
  }

  // Other categories (탁주, 소스, etc.) - still searchable
  if (category === '탁주' || category === '소스') {
    return 'Other';
  }

  // Fallback: use HS-CODE only
  if (hsCode.startsWith('2204')) return 'Wine';
  if (hsCode.startsWith('2206')) return 'Sake';
  if (hsCode.startsWith('2208')) return 'Spirits';

  return 'Other';  // Safe default
}

export async function handleInitUpload(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${c.env.ADMIN_PASSWORD}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
  const { error } = await supabase.rpc('truncate_sake_imports');

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
}

export async function handleUploadChunk(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${c.env.ADMIN_PASSWORD}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json();
  let data = body.data as ExcelRow[];

  if (!data || !Array.isArray(data) || data.length === 0) {
    return c.json({ ok: true, updated: 0, inserted: 0 });
  }

  // 엑셀 컬럼명의 공백 제거 (예: ' Value ' → 'Value')
  data = data.map(row => {
    const cleanedRow: any = {};
    for (const key in row) {
      const cleanKey = key.trim();
      cleanedRow[cleanKey] = row[key];
    }
    return cleanedRow as ExcelRow;
  });

  // 필수 컬럼(Product Name (KR))이 없는 행 제거
  data = data.filter(row => row['Product Name (KR)'] && String(row['Product Name (KR)']).trim().length > 0);

  if (data.length === 0) {
    return c.json({ ok: true, updated: 0, inserted: 0 });
  }

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);

  try {
    console.log(`[UPLOAD] Processing ${data.length} rows`);

    // 1. DB 저장을 위한 이름 생성 (한글 + 영문) + 카테고리 분류
    const processedData = data.map(row => {
      const krName = String(row['Product Name (KR)']).trim();
      const enName = row['Product Name (EN)'] ? String(row['Product Name (EN)']).trim() : '';

      // DB에 저장될 이름: "닷사이 23 (Dassai 23)" 형식
      const displayName = enName ? `${krName} (${enName})` : krName;

      // 임베딩 생성을 위한 텍스트: 한글 + 영문 + Exporter + Origin Country
      const embeddingText = [
        krName,
        enName,
        row['Exporter'],
        row['Origin Country']
      ].filter(Boolean).join(' ').trim();

      // Category + HS-CODE 기반 자동 분류
      const category = getCategoryFromExcelData(row);

      return {
        ...row,
        displayName,
        embeddingText,
        category
      };
    });

    // 2. DB에서 이미 존재하는 제품명 + 제조사 조회
    const displayNames = processedData.map(d => d.displayName);
    const { data: existingProducts, error: selectError } = await supabase
      .from('sake_imports')
      .select('reported_product_name, exporter, origin_country, raw_importer_name')
      .in('reported_product_name', displayNames);

    if (selectError) {
      console.error('[UPLOAD] Supabase select error:', selectError);
      throw selectError;
    }

    // Build 4-field composite key map: "name|exporter|origin|importer"
    const existingMap = new Map<string, boolean>();
    for (const product of existingProducts || []) {
      const compositeKey = `${product.reported_product_name}|${product.exporter || ''}|${product.origin_country || ''}|${product.raw_importer_name || ''}`;
      existingMap.set(compositeKey, true);
    }

    console.log(`[UPLOAD] Found ${existingMap.size} existing (name+exporter+origin+importer) combinations`);

    // 3. 기존/신규 분리 (제품명 + 제조사 + 원산지 + 수입사 조합으로 판단)
    const toUpdate = [];
    const toInsert = [];

    for (const item of processedData) {
      // Build 4-field composite key
      const compositeKey = `${item.displayName}|${item['Exporter'] || ''}|${item['Origin Country'] || ''}|${item['Raw Importer Name'] || ''}`;

      if (existingMap.has(compositeKey)) {
        toUpdate.push(item);
      } else {
        toInsert.push(item);
      }
    }

    console.log(`[UPLOAD] To update: ${toUpdate.length}, to insert: ${toInsert.length}`);

    let updatedCount = 0;
    let insertedCount = 0;

    // 4. 기존 제품: RPC로 일괄 UPDATE (임베딩 생성 X)
    if (toUpdate.length > 0) {
      console.log(`[UPLOAD] Updating ${toUpdate.length} products via bulk RPC...`);

      // Convert to RPC format
      const updates = toUpdate.map(row => ({
        name: row.displayName,
        exporter: row['Exporter'] || null,
        origin: row['Origin Country'] || null,
        importer: row['Raw Importer Name'] || null,
        category: row.category,
        value: row['Value'] || null,
        volume: row['Volume'] || null,
        unit_price: row['Unit Price'] || null,
      }));

      // Single RPC call to update all rows (1 network round-trip instead of 100)
      const { data: rpcResult, error: rpcError } = await supabase.rpc('bulk_update_sake_imports', {
        updates: updates
      });

      if (rpcError) {
        console.error('[UPLOAD] Bulk update RPC error:', rpcError);
        throw rpcError;
      }

      updatedCount = rpcResult || 0;
      console.log(`[UPLOAD] Updated ${updatedCount} products successfully via RPC`);
    }

    // 5. 신규 제품: 임베딩 생성 후 INSERT
    if (toInsert.length > 0) {
      const embeddingTexts = toInsert.map(item => item.embeddingText);

      console.log(`[UPLOAD] Generating ${toInsert.length} embeddings via Gemini API...`);
      const embeddings = await retryWithBackoff(
        () => getBatchEmbeddings(c.env, embeddingTexts),
        3,     // Max 3 retries
        2000   // Start with 2s delay
      );
      console.log(`[UPLOAD] Embeddings generated successfully`);

      const rows = toInsert.map((item, idx) => ({
        reported_product_name: item.displayName,
        category: item.category,
        exporter: item['Exporter'] || null,
        origin_country: item['Origin Country'] || null,
        raw_importer_name: item['Raw Importer Name'] || null,
        value: item['Value'] || null,
        volume: item['Volume'] || null,
        unit_price: item['Unit Price'] || null,
        name_embedding: embeddings[idx],
      }));

      const { error: insertError } = await supabase.from('sake_imports').insert(rows);
      if (insertError) {
        console.error('[UPLOAD] Supabase insert error:', insertError);
        throw insertError;
      }

      insertedCount = rows.length;
      console.log(`[UPLOAD] Inserted ${insertedCount} products successfully`);
    }

    console.log(`[UPLOAD] Chunk complete: ${updatedCount} updated, ${insertedCount} inserted`);

    return c.json({
      ok: true,
      updated: updatedCount,
      inserted: insertedCount,
      total: updatedCount + insertedCount
    });

  } catch (error) {
    console.error('[UPLOAD] Upload chunk error:', error);

    // Extract error message from multiple sources
    let errorMessage = 'Unknown error';

    if (error instanceof Error) {
      // Standard JavaScript Error
      errorMessage = error.message;
    } else if (error && typeof error === 'object') {
      // Supabase errors: { message, code, details, hint }
      if ('message' in error) {
        errorMessage = String(error.message);
        if ('code' in error) {
          errorMessage += ` (Code: ${error.code})`;
        }
        if ('details' in error && error.details) {
          errorMessage += ` - ${error.details}`;
        }
      } else {
        // Unknown object - stringify for debugging
        errorMessage = JSON.stringify(error);
      }
    } else if (typeof error === 'string') {
      errorMessage = error;
    }

    return c.json({ error: errorMessage }, 500);
  }
}

export async function handleStats(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${c.env.ADMIN_PASSWORD}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
  const { data, error } = await supabase.rpc('get_stats');

  if (error) return c.json({ error: 'Failed to get stats' }, 500);
  return c.json(data);
}
