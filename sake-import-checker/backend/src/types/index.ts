export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  ADMIN_PASSWORD: string;
  ADMIN_CHAT_ID?: string;
  ENVIRONMENT: string;
  PHOTO_QUEUE: Queue<PhotoQueueMessage>;
}

// Cloudflare Queue 메시지 타입
export interface PhotoQueueMessage {
  chatId: number;
  messageId: number;
  fileId: string;
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
  errorType?: 'RATE_LIMIT';

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
