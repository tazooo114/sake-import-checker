/**
 * 실행 위치(Cloudflare PoP) 진단용 로깅.
 *
 * Gemini는 호출 지역을 "API를 호출한 기계의 IP"로 판정한다(사람의 위치가 아니다).
 * Workers에서 그 기계는 Worker 아이솔레이트를 실행 중인 엣지 PoP이므로,
 * 'User location is not supported' 오류의 원인을 특정하려면 실행 PoP를 알아야 한다.
 *
 * 한국·일본·싱가포르는 Gemini 허용 지역이고 홍콩은 아니다.
 *
 * 2026-08-23 측정으로 확정된 사실:
 *   - 관리자 HTTP 경로는 클라이언트가 붙는 PoP에서 실행된다. 이 환경(한국 ISP,
 *     VPN 없음)에서는 HKG에 붙고, Gemini가 20/20 전부 거절한다. 결정적이다.
 *   - VPN을 켜면 ICN에 붙어 통과한다. 사람의 위치가 아니라 PoP이 바뀌는 것이다.
 *     업로드에 매번 VPN이 필요했던 이유가 이것이다.
 *   - 요청 안에서의 재시도(retryWithBackoff)는 같은 colo에 갇혀 무의미하다.
 *     브라우저의 fetchWithRetry도 같은 PoP에 다시 붙으므로 마찬가지다.
 *   - 큐 컨슈머는 붙을 클라이언트가 없어 무관한 위치에서 돈다(측정값 SJC/US).
 *     탈출 경로는 이것뿐이다.
 */

const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace';
const TRACE_TIMEOUT_MS = 3000;

export interface ColoInfo {
  /**
   * 이 실행 컨텍스트가 도는 데이터센터 코드 (예: ICN, HKG, NRT).
   * 지역 차단 여부를 가르는 건 이 값 하나다. HKG면 Gemini가 100% 막힌다.
   */
  colo: string;
  /**
   * 클라이언트의 국가 코드. **데이터센터의 국가가 아니다.**
   * colo=HKG인데 loc=KR로 나올 수 있으니 이 값으로 판단하면 안 된다.
   */
  loc: string;
  /** HTTP 요청이 최초로 도착한 데이터센터. 큐 컨슈머에는 없다. */
  ingress?: string;
  error?: string;
}

/**
 * 실행 PoP를 조회해 `[COLO]` 태그로 로그를 남긴다.
 *
 * 진단이 실패해도 호출부에 영향이 없도록 예외를 삼킨다.
 */
export async function logColo(tag: string, ingressColo?: string): Promise<ColoInfo> {
  const info: ColoInfo = { colo: '?', loc: '?' };
  if (ingressColo) info.ingress = ingressColo;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRACE_TIMEOUT_MS);

  try {
    const response = await fetch(TRACE_URL, { signal: controller.signal });
    const text = await response.text();

    // trace 응답은 `key=value` 한 줄씩이다.
    const field = (key: string) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
    info.colo = field('colo') ?? '?';
    info.loc = field('loc') ?? '?';
  } catch (error) {
    info.error = String(error).slice(0, 100);
  } finally {
    clearTimeout(timeoutId);
  }

  console.log(
    `[COLO] ${tag} — ` +
    (info.ingress ? `ingress=${info.ingress} ` : '') +
    `colo=${info.colo} loc=${info.loc}` +
    (info.error ? ` trace_failed=${info.error}` : '')
  );

  return info;
}
