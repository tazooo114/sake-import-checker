import type { Context } from 'hono';
import type { Env, ExcelRow, ProductCategory } from '../types';
import { createClient } from '@supabase/supabase-js';
import { getBatchEmbeddings } from '../services/gemini';
import { logColo } from '../utils/colo';

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

  // 실행 PoP 진단(임시). Gemini 임베딩 호출이 실제로 나가는 경로가 여기다.
  // 응답을 지연시키지 않도록 waitUntil로 흘려보낸다.
  c.executionCtx.waitUntil(logColo('http/upload-chunk', (c.req.raw as any).cf?.colo));

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
    const toUpdate: typeof processedData = [];
    const toInsert: typeof processedData = [];

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

    // 5. 신규 제품: 임베딩 없이 INSERT하고, 임베딩 생성은 큐에 위임한다.
    //
    // Gemini를 여기서 직접 부르지 않는 이유는 지역 차단이다. 이 HTTP 핸들러는
    // 관리자가 접속한 PoP에서 실행되는데, 그게 홍콩이면 Gemini가 100% 거절한다.
    // 요청 안에서 재시도해도 같은 colo에 갇혀 소용이 없다. 근거는 utils/colo.ts 참고.
    //
    // 임베딩이 채워지기 전까지 그 행은 검색에 잡히지 않는다. search_products의
    // `1 - (name_embedding <=> query) > threshold`가 NULL이면 참이 아니므로
    // 자연히 제외된다 — 틀린 결과가 나오는 게 아니라 아직 안 보일 뿐이다.
    if (toInsert.length > 0) {
      const rows = toInsert.map(item => ({
        reported_product_name: item.displayName,
        category: item.category,
        exporter: item['Exporter'] || null,
        origin_country: item['Origin Country'] || null,
        raw_importer_name: item['Raw Importer Name'] || null,
        value: item['Value'] || null,
        volume: item['Volume'] || null,
        unit_price: item['Unit Price'] || null,
      }));

      const { data: insertedRows, error: insertError } = await supabase
        .from('sake_imports')
        .insert(rows)
        .select('id');

      if (insertError) {
        console.error('[UPLOAD] Supabase insert error:', insertError);
        throw insertError;
      }

      // INSERT ... RETURNING은 입력한 순서대로 반환하므로 인덱스로 짝지을 수 있다.
      // 제품명은 유일하지 않아(4필드 복합키를 쓰는 이유) 이름으로는 짝지을 수 없다.
      if (!insertedRows || insertedRows.length !== toInsert.length) {
        throw new Error(
          `INSERT 반환 행 수 불일치: ${insertedRows?.length ?? 0} !== ${toInsert.length}. ` +
          `id를 신뢰할 수 없어 임베딩 요청을 보내지 않았습니다.`
        );
      }

      const items = insertedRows.map((row, idx) => ({
        id: row.id as number,
        text: toInsert[idx].embeddingText,
      }));

      await c.env.EMBED_QUEUE.send({ kind: 'embed', items });

      insertedCount = items.length;
      console.log(`[UPLOAD] Inserted ${insertedCount} products, queued for embedding`);
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

/**
 * 지역 차단 진단(임시).
 *
 * colo 로깅만으로는 부족하다. cdn-cgi/trace는 Cloudflare 자기 도메인이라
 * 서브리퀘스트가 네트워크 밖으로 나가지 않을 수 있어, 아이솔레이트가 도는
 * colo는 알려주지만 구글이 보는 egress IP는 알려주지 못한다.
 *
 * 그래서 실제로 Gemini 임베딩을 한 번 호출해 통과 여부를 확인한다.
 * 이 경로가 성공하면 업로드는 VPN 없이 되는 것이고, 실패하면 큐로 옮겨야 한다.
 */
export async function handleColoProbe(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${c.env.ADMIN_PASSWORD}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const colo = await logColo('http/colo-probe', (c.req.raw as any).cf?.colo);

  // 1회 성공은 근거가 약하다. 실패가 확률적이라면(egress IP마다 지오IP 판정이 다름)
  // 호출을 많이 하는 업로드(~100회)만 걸리고 1회 프로브는 통과한다.
  // 그래서 반복 호출로 '호출당 실패율'을 직접 잰다.
  const repeat = Math.min(Math.max(Number(c.req.query('n') ?? 20), 1), 50);
  const batchSize = Math.min(Math.max(Number(c.req.query('batch') ?? 50), 0), 100);

  const errors = new Map<string, number>();
  let ok = 0;

  for (let i = 0; i < repeat; i++) {
    try {
      await getBatchEmbeddings(c.env, [`지역 확인용 문자열 ${i}`]);
      ok++;
    } catch (error) {
      const key = String(error).slice(0, 200);
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
  }

  // 업로드가 실제로 쓰는 모양(한 번에 50건)도 그대로 쳐본다.
  let batch: { size: number; ok: boolean; detail: string } | null = null;
  if (batchSize > 0) {
    const texts = Array.from({ length: batchSize }, (_, i) => `배치 확인용 문자열 ${i}`);
    try {
      const embeddings = await getBatchEmbeddings(c.env, texts);
      batch = { size: batchSize, ok: true, detail: `${embeddings.length}건 수신` };
    } catch (error) {
      batch = { size: batchSize, ok: false, detail: String(error).slice(0, 200) };
    }
  }

  const failures = Array.from(errors, ([detail, count]) => ({ count, detail }));

  console.log(
    `[COLO] gemini_from_http — single ${ok}/${repeat} ok` +
    (batch ? `, batch(${batch.size}) ${batch.ok ? 'OK' : 'FAIL'}` : '')
  );
  for (const f of failures) {
    console.log(`[COLO] failure ×${f.count}: ${f.detail}`);
  }

  return c.json({ colo, single: { ok, total: repeat, failures }, batch });
}

/**
 * 임베딩이 아직 채워지지 않은 행을 보고한다.
 *
 * 업로드는 INSERT만 하고 임베딩은 큐가 채우므로, 큐가 밀리거나 DLQ로 빠지면
 * `name_embedding IS NULL`인 행이 남는다. 그 행은 검색에 잡히지 않으니
 * "업로드는 성공했는데 검색이 안 된다"로 나타난다. 이 엔드포인트가 그걸 드러낸다.
 *
 * 업로드 직후에는 0이 아닌 게 정상이다. 큐가 소진되면 0으로 수렴해야 한다.
 * 계속 0이 아니면 DLQ를 확인해야 한다.
 *
 * 자동 복구를 넣지 않은 이유: 임베딩 원문이 DB에 없어서 재조립하면 문자열이
 * 달라지고(괄호 유무), 임베딩 레시피가 두 종류로 갈린다. 진짜 자가 복구를
 * 하려면 embedding_text 컬럼을 추가해야 한다 — 별도 작업으로 남겨둔다.
 */
export async function handleEmbeddingStatus(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${c.env.ADMIN_PASSWORD}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);

  const { count, error: countError } = await supabase
    .from('sake_imports')
    .select('id', { count: 'exact', head: true })
    .is('name_embedding', null);

  if (countError) {
    return c.json({ error: countError.message }, 500);
  }

  const { data: sample, error: sampleError } = await supabase
    .from('sake_imports')
    .select('id, reported_product_name, created_at')
    .is('name_embedding', null)
    .order('created_at', { ascending: false })
    .limit(10);

  if (sampleError) {
    return c.json({ error: sampleError.message }, 500);
  }

  return c.json({ pending: count ?? 0, sample: sample ?? [] });
}

/**
 * 임베딩 큐 경로 자체 점검.
 *
 * 업로드할 데이터가 없어도 경로 전체를 실행해볼 수 있게 한다. 존재하지 않는
 * id(-1)로 임베딩 요청을 넣으므로 **DB는 한 줄도 바뀌지 않는다.**
 * BIGSERIAL은 1부터 시작하니 음수 id는 어떤 행과도 매칭되지 않는다.
 *
 * 이걸로 확인되는 것: 큐 라우팅(batch.queue 분기), 컨슈머 실행 colo,
 * 컨슈머에서의 Gemini 호출 통과 여부, Supabase 접근.
 * 확인되지 않는 것: INSERT의 id 회수와 순서 매칭 — 그건 실업로드로만 검증된다.
 *
 * 로그에서 볼 것:
 *   [COLO] queue/embed — colo=...     (허용 지역이어야 함)
 *   [EMBED] Filled 0/1 embeddings     (0이 정상. 매칭될 행이 없으므로)
 * Gemini가 막히면 [EMBED] Failed가 찍히고 재시도로 넘어간다.
 */
export async function handleEmbedSelfTest(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header('Authorization');
  if (authHeader !== `Bearer ${c.env.ADMIN_PASSWORD}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await c.env.EMBED_QUEUE.send({
    kind: 'embed',
    items: [{ id: -1, text: '임베딩 큐 자체 점검용 문자열' }],
  });

  return c.json({
    ok: true,
    note: 'DB는 변경되지 않습니다. wrangler tail에서 [COLO] queue/embed 와 [EMBED] Filled 0/1 을 확인하세요.',
  });
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
