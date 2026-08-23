export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  ADMIN_PASSWORD: string;
  ADMIN_CHAT_ID?: string;
  // setWebhook의 secret_token과 반드시 같은 값이어야 한다.
  // 설정되지 않으면 웹훅 검증을 건너뛴다 (기존 동작 유지).
  TELEGRAM_WEBHOOK_SECRET?: string;
  ENVIRONMENT: string;
  PHOTO_QUEUE: Queue<QueueMessage>;
  /**
   * 엑셀 업로드의 임베딩 생성 전용 큐.
   *
   * 사진 검색 큐와 분리한 이유: 업로드 한 번이 메시지 수십~수백 건을 밀어넣는데,
   * max_batch_size=1인 photo-search-queue를 공유하면 그 뒤에 들어온 사용자 사진이
   * 전부 소진될 때까지 대기하게 된다.
   */
  EMBED_QUEUE: Queue<EmbedQueueMessage>;
}

// Cloudflare Queue 메시지 타입
export interface PhotoQueueMessage {
  chatId: number;
  messageId: number;
  fileId: string;
}

/**
 * 검색 평가 픽스처.
 *
 * `expect`는 정답 제품명에 포함되는 문자열(부분 일치, 대소문자 무시)이다.
 */
export interface SearchEvalFixture {
  name: string;
  expect: string;
  note?: string;
  extracted: Partial<ExtractedLabelInfo> & { productType: ProductCategory };
}

/**
 * 평가 실행 요청.
 *
 * 평가를 HTTP 핸들러에서 바로 돌리지 않고 큐에 넣는 이유: Cloudflare Workers는
 * 요청을 받은 엣지 위치에서 외부 호출을 내보내는데, 관리자 HTTP 요청이 도달하는
 * 위치에서는 Gemini 임베딩 API가 `User location is not supported`(400)로 거절한다.
 * 큐 컨슈머는 사진 검색이 매일 정상 동작하는, Gemini가 허용하는 위치에서 실행되므로
 * 같은 경로를 재사용한다.
 */
export interface EvalQueueMessage {
  kind: 'search-eval';
  /** 생략하면 저장소 픽스처를 쓴다. */
  fixtures?: SearchEvalFixture[];
  /** 결과를 보낼 텔레그램 chat_id. 생략하면 ADMIN_CHAT_ID로 보낸다. */
  chatId?: number;
}

/**
 * 임베딩 생성 요청. 이미 INSERT된 행의 `name_embedding`을 채운다.
 *
 * **텍스트를 그대로 실어 보내는 이유**: 임베딩 원문은 DB에 저장되지 않는다.
 * DB에 있는 건 `"닷사이 23 (Dassai 23)"`(괄호 포함)인데 임베딩 원문은
 * `"닷사이 23 Dassai 23 Asahi Shuzo Japan"`(괄호 없음)이다. id만 보내고
 * 컨슈머가 DB에서 재조립하면 문자열이 달라져 임베딩 레시피가 두 종류로
 * 갈리고, 기존 행과 신규 행의 유사도 기준이 어긋난다.
 *
 * 크기: id(BIGSERIAL) + 텍스트 ≈ 100 B/건. 50건이면 약 5 KB로,
 * Cloudflare Queues의 메시지 한도 128 KB에 한참 못 미친다.
 */
export interface EmbedQueueMessage {
  kind: 'embed';
  items: Array<{ id: number; text: string }>;
}

export type QueueMessage = PhotoQueueMessage | EvalQueueMessage;

export function isEvalMessage(m: QueueMessage): m is EvalQueueMessage {
  return (m as EvalQueueMessage).kind === 'search-eval';
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  photo?: TelegramPhotoSize[];
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// Product category types including sub-categories
export type ProductCategory =
  | 'Sake'         // 청주 (clear sake)
  | 'Wine'         // 과실주 (wine)
  | 'Spirits'      // 소주, 일반증류주 (spirits)
  | 'Etc-Wine'     // 기타주류/리큐르 with HS-CODE 2204xx
  | 'Etc-Sake'     // 기타주류 with HS-CODE 220600
  | 'Etc-Spirits'  // 기타주류/리큐르 with HS-CODE 2208xx
  | 'Other';       // 탁주, 소스, unclassified

export interface ExtractedLabelInfo {
  productType: ProductCategory;  // AI-detected product type
  brand: string;
  brandKorean: string;
  brandEnglish: string;
  exporterEnglish: string;  // For both sake and wine (wine: winery name)
  exporterOriginal?: string; // Original language name (e.g., Japanese Kanji for Sake)
  numbers: string[];
  volume: string;
  rawText: string;
  confidence: number;
  // 추출이 실패한 경우에만 설정된다. 이 값이 있으면 confidence는 항상 0이고,
  // 나머지 필드(rawText 포함)는 전부 빈 값이다 — 실패 산출물이 검색어로 흘러가지 않도록.
  errorType?: 'RATE_LIMIT' | 'EXTRACTION_FAILED' | 'PARSE_FAILED';

  // Wine-specific metadata (extracted from label, used for search prioritization)
  region?: string;       // e.g., "Bordeaux", "Napa Valley"
  grapeVariety?: string; // e.g., "Cabernet Sauvignon", "Pinot Noir"
  vintage?: string;      // e.g., "2018", "2020"
}

// Product interface (formerly SakeProduct, now supports all product types)
export interface Product {
  id: number;
  reported_product_name: string;
  category: ProductCategory | null;
  exporter: string | null;  // For wine, this is the winery
  origin_country: string | null;
  raw_importer_name: string | null;
  value: number | null;
  volume: number | null;
  unit_price: number | null;
  similarity?: number;
}

// Backward compatibility alias
export type SakeProduct = Product;

export interface SearchResult {
  found: boolean;
  confidence: number;
  product: Product | null;
  candidates: Product[];
  extractedInfo: ExtractedLabelInfo | null;
  message: string;
}

export interface UploadProgress {
  session_id: string;
  current_count: number;
  total_count: number;
  status: 'pending' | 'processing' | 'complete' | 'error';
  error_message?: string;
}

export interface ExcelRow {
  'Product Name (KR)': string;
  'Product Name (EN)'?: string;
  'Category': string;        // Korean category (과실주, 청주, 기타주류, etc.) - Required
  'Exporter'?: string;       // For wine, this is the winery
  'Origin Country'?: string;
  'Raw Importer Name'?: string;
  'Value'?: number;
  'Volume'?: number;
  'Unit Price'?: number;
  'HS-CODE': string;         // Used for sub-categorization (Etc-Wine, etc.) - Required
}
