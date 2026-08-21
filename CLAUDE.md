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

`backend/.nvmrc`(=20)와 `package.json`의 `engines.node`(>=20.0.0)가 이 제약을 기록하고 있다. 대화형 셸에서는 `cd backend && nvm use`로 한 번 전환하면 그 세션 동안은 접두사 없이 쓸 수 있다.

## sake-import-checker — 배포·운영

- 배포: `backend/`에서 `npx wrangler deploy` (위 PATH 접두사 필요)
- 로그: `npx wrangler tail --format pretty`. 사진 검색의 Gemini 호출은 웹훅 POST가 아니라 **큐 컨슈머 실행**에서 일어나므로 로그가 몇 초 뒤 별도 이벤트로 찍힌다.
- 시크릿은 `wrangler secret put`으로 넣으며 **값을 다시 읽을 수 없다**(이름만 조회 가능). 시크릿 값을 셸 명령줄에 직접 타이핑하지 말 것 — 히스토리에 남는다. `wrangler secret put`은 stdin으로 받으므로 안전하다.
- 로컬 개발용 값은 `backend/.dev.vars`에 둔다(gitignore됨).

## 개선 작업 추적

`sake-import-checker/docs/feedback.md`가 코드 리뷰 결과와 우선순위표(진행 상태 포함)를 담고 있다. 이 프로젝트에서 개선 작업을 할 때는 해당 항목의 상태를 같이 갱신할 것.
