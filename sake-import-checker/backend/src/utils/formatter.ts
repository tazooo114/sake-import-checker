import type { SearchResult, Product, ProductCategory } from '../types';

// Helper: Get category-aware exporter label
function getExporterLabel(category: ProductCategory | null): string {
  if (category === 'Wine' || category === 'Etc-Wine') {
    return '와이너리';
  }
  return '제조사/수출사';
}

export function formatSearchResult(result: SearchResult): string {
  if (result.found && result.product) {
    return formatFoundProduct(result.product, result.confidence);
  }

  if (result.confidence >= 50 && result.product) {
    return formatUncertainResult(result);
  }

  if (result.candidates.length > 0) {
    return formatNotFoundWithCandidates(result);
  }

  // If no candidates found but we have extracted info, show it
  if (!result.found && result.extractedInfo && result.extractedInfo.confidence >= 50) {
    return formatNotFoundWithExtractedInfo(result);
  }

  return result.message;
}

function formatFoundProduct(product: Product, confidence: number): string {
  const lines = [
    `<b>${product.reported_product_name}</b>`,
    '',
  ];

  if (product.exporter) {
    lines.push(`${getExporterLabel(product.category)}: ${product.exporter}`);
  }

  if (product.raw_importer_name) {
    lines.push(`수입사: ${product.raw_importer_name}`);
  }

  if (product.category) {
    lines.push(`카테고리: ${product.category}`);
  }

  if (product.volume) {
    lines.push(`총 수입규모: ${product.volume.toLocaleString()}kg`);
  }

  if (product.value) {
    lines.push(`총 수입액: $${product.value.toLocaleString()}`);
  }

  if (product.unit_price) {
    lines.push(`단가: $${product.unit_price.toFixed(2)}`);
  }

  lines.push('');
  lines.push(`확신도: ${confidence}%`);

  return lines.join('\n');
}

function formatUncertainResult(result: SearchResult): string {
  const lines = [
    `⚠️ ${result.message}`,
    '',
  ];

  if (result.product) {
    lines.push(`<b>${result.product.reported_product_name}</b>`);

    if (result.product.exporter) {
      lines.push(`${getExporterLabel(result.product.category)}: ${result.product.exporter}`);
    }

    if (result.product.raw_importer_name) {
      lines.push(`수입사: ${result.product.raw_importer_name}`);
    }

    if (result.product.volume) {
      lines.push(`총 수입규모: ${result.product.volume.toLocaleString()}kg`);
    }
  }

  lines.push('');
  lines.push(`확신도: ${result.confidence}%`);

  return lines.join('\n');
}

function formatNotFoundWithCandidates(result: SearchResult): string {
  const lines = [
    result.message,
    '',
  ];

  // 2. Extracted Info (if available and high confidence)
  if (result.extractedInfo && result.extractedInfo.confidence >= 50) {
    const info = result.extractedInfo;
    lines.push('<b>🔍 분석된 라벨 정보:</b>');

    // Brand: Korean (Original)
    const brandStr = [];
    if (info.brandKorean) brandStr.push(info.brandKorean);
    if (info.brand && info.brand !== info.brandKorean) brandStr.push(`(${info.brand})`);
    if (brandStr.length > 0) lines.push(`제품명: ${brandStr.join(' ')}`);

    // Exporter: ExporterEnglish + ExporterOriginal
    if (info.exporterEnglish) {
      const exporterStr = [info.exporterEnglish];
      if (info.exporterOriginal && info.exporterOriginal !== info.exporterEnglish) {
        exporterStr.push(`(${info.exporterOriginal})`);
      }
      lines.push(`제조사: ${exporterStr.join(' ')}`);
    }

    if (info.volume) lines.push(`용량: ${info.volume}`);

    if (info.productType === 'Wine') {
      if (info.region) lines.push(`지역: ${info.region}`);
      if (info.grapeVariety) lines.push(`품종: ${info.grapeVariety}`);
      if (info.vintage) lines.push(`빈티지: ${info.vintage}`);
    }
    lines.push('');
  }

  // 3. Candidates
  lines.push('유사한 제품:');
  result.candidates.slice(0, 3).forEach((candidate, index) => {
    lines.push(`${index + 1}. ${candidate.reported_product_name}`);
    if (candidate.exporter) {
      lines.push(`   ${getExporterLabel(candidate.category)}: ${candidate.exporter}`);
    }
  });

  return lines.join('\n');
}

export function formatNumber(num: number): string {
  return num.toLocaleString('ko-KR');
}

function formatNotFoundWithExtractedInfo(result: SearchResult): string {
  const info = result.extractedInfo!;
  const lines = [
    result.message,
    '',
    '<b>🔍 분석된 라벨 정보:</b>',
  ];

  // Brand: Korean (Original)
  const brandStr = [];
  if (info.brandKorean) brandStr.push(info.brandKorean);
  if (info.brand && info.brand !== info.brandKorean) brandStr.push(`(${info.brand})`);
  if (brandStr.length > 0) lines.push(`제품명: ${brandStr.join(' ')}`);

  if (info.exporterEnglish) {
    const exporterStr = [info.exporterEnglish];
    if (info.exporterOriginal && info.exporterOriginal !== info.exporterEnglish) {
      exporterStr.push(`(${info.exporterOriginal})`);
    }
    lines.push(`제조사: ${exporterStr.join(' ')}`);
  }

  if (info.volume) {
    lines.push(`용량: ${info.volume}`);
  }

  if (info.productType === 'Wine') {
    if (info.region) lines.push(`지역: ${info.region}`);
    if (info.grapeVariety) lines.push(`품종: ${info.grapeVariety}`);
    if (info.vintage) lines.push(`빈티지: ${info.vintage}`);
  }

  return lines.join('\n');
}
