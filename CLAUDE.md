# monodream

포트폴리오 저장소. 하위 프로젝트별로 스택이 다르므로 아래 항목은 명시된 디렉터리에만 적용된다.

## sake-import-checker/backend — Node 버전 (중요)

**시스템 기본 Node는 v16.4.2(Homebrew)인데 이 프로젝트의 도구는 Node 20+를 요구한다.** 그냥 `npx wrangler`나 `npx vitest`를 실행하면 실패한다.

- `wrangler` 4.x → `Wrangler requires at least Node.js v20.0.0` 로 즉시 종료
- `vitest` / vite → `TypeError: crypto$2.getRandomValues is not a function` (globalThis.crypto가 없음)

nvm에 v20.20.2와 v24.12.0이 설치돼 있다. 명령마다 PATH를 앞에 붙여서 실행할 것:

```bash
PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" npx wrangler deploy
PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" npx vitest run
PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" npx tsc --noEmit
```

`nvm use`는 셸 세션 안에서만 유효하고, 각 명령이 새 셸에서 도는 환경에서는 넘어가지 않는다. 그래서 PATH 접두사 방식을 쓴다.

**함정**: 환경변수 접두사는 **바로 뒤 명령 하나에만** 적용된다. `PATH="..." npx wrangler deploy && npx wrangler tail`에서 `tail`은 원래 PATH로 돌아가 Node 16으로 실행되어 실패한다. 명령을 이어붙일 때는 `export`를 쓸 것:

```bash
cd backend && export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" && npx wrangler deploy && npx wrangler tail --format pretty
```

`backend/.nvmrc`(=20)와 `package.json`의 `engines.node`(>=20.0.0)가 이 제약을 기록하고 있다. 대화형 셸에서는 `cd backend && nvm use`로 한 번 전환하면 그 세션 동안은 접두사 없이 쓸 수 있다.

## sake-import-checker — 배포·운영

- 배포: `backend/`에서 `npx wrangler deploy` (위 PATH 접두사 필요)
- 로그: `npx wrangler tail --format pretty`. 사진 검색의 Gemini 호출은 웹훅 POST가 아니라 **큐 컨슈머 실행**에서 일어나므로 로그가 몇 초 뒤 별도 이벤트로 찍힌다.
- 시크릿은 `wrangler secret put`으로 넣으며 **값을 다시 읽을 수 없다**(이름만 조회 가능). 시크릿 값을 셸 명령줄에 직접 타이핑하지 말 것 — 히스토리에 남는다. `wrangler secret put`은 stdin으로 받으므로 안전하다.
- 로컬 개발용 값은 `backend/.dev.vars`에 둔다(gitignore됨).

### 큐 생성은 설치된 wrangler로 안 된다

프로젝트에 설치된 wrangler 4.54는 `wrangler queues create`가 `The specified queue settings are invalid.` (API 400)로 실패한다. wrangler.toml 문제가 아니라 그 버전 자체의 문제이며, 다른 디렉터리에서 실행해도 같다. `wrangler queues list`나 `deploy` 같은 다른 큐 명령은 정상 동작한다.

큐를 만들 때만 최신 wrangler를 일회성으로 쓴다. 최신 wrangler는 Node 22+를 요구하므로 v24를 써야 한다:

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npx -y wrangler@latest queues create <queue-name>
```

배포·로그 등 나머지 작업은 계속 v20 + 설치된 wrangler로 한다(위 참조). 프로젝트의 wrangler 버전은 올리지 않았다.

**함정**: 에러 로그의 실제 API 응답은 마스킹되어 있다. `WRANGLER_LOG_SANITIZE=false`로 풀 수 있지만 그러면 **인증 토큰이 로그 파일에 평문으로 남으므로 쓰지 말 것.**

### Gemini 지역 차단 (중요)

Gemini는 호출 지역을 **API를 호출한 기계의 IP**로 판정한다(사람의 위치가 아니다). Workers에서 그 기계는 Worker를 실행 중인 엣지 PoP이다.

- 이 개발 환경(한국 ISP, VPN 없음)에서 관리자 HTTP 요청은 **HKG(홍콩)** 에 붙고, 홍콩은 Gemini 비허용 지역이라 **100% 차단**된다. 확률적이 아니라 결정적이다(20/20 실패 확인).
- VPN을 켜면 ICN에 붙어 통과한다. 업로드에 매번 VPN이 필요했던 이유가 이것이다.
- 요청 안에서의 재시도는 같은 colo에 갇혀 무의미하다. 브라우저 재시도도 같은 PoP에 다시 붙으므로 마찬가지다.
- **큐 컨슈머는 붙을 클라이언트가 없어 무관한 위치에서 돈다**(측정값 SJC/US). 그래서 Gemini 호출은 전부 큐 컨슈머에서 한다.

진단: `GET /admin/colo-probe?n=20` (관리자 인증). 실행 colo와 Gemini 통과 여부를 함께 돌려준다.

## 개선 작업 추적

`sake-import-checker/docs/feedback.md`가 코드 리뷰 결과와 우선순위표(진행 상태 포함)를 담고 있다. 이 프로젝트에서 개선 작업을 할 때는 해당 항목의 상태를 같이 갱신할 것.

## 문서 갱신 (중요)

이 저장소의 고질적 문제는 **코드·문서·실제 배포가 서로 어긋나는 것**이다. 코드를 고쳤으면 문서도 같이 고친다.

`sake-import-checker/README.md`의 **"문서 지도 — 무엇을 바꾸면 무엇을 갱신하는가"** 표가 기준이다. 코드를 변경하기 전에 그 표에서 해당 행을 찾아, 어떤 문서를 함께 손봐야 하는지 먼저 확인할 것. 같은 README에 현재 구성도가 있으니 실제 구조를 파악할 때도 여기서 시작하면 된다.

새 구성 요소(큐, 엔드포인트, 외부 서비스)를 추가했다면 그 표에도 행을 추가한다.
