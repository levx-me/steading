# 탭

[English](tabs.md) · **한국어** · [← README](../README.ko.md)

모든 탭은 같은 방식으로 동작합니다. 위에는 실행 목록이 최신순으로(최근 20개, git은 50개), 아래에는 고른
실행의 출력이 나옵니다. 탭 이름 옆에는 최근 상태가 붙습니다. `✓` `✗`, 실행 중이면 스피너, 떠 있는 서버는
`●`입니다. 다른 탭에 새 실행이 들어오면 그 탭이 빨갛게 바뀌고, 그 탭을 열 때까지 그대로입니다. 탭 줄 오른쪽 끝에는 그런 탭의 수(`2 new`)가 나오고, 화면 밖으로 밀린 쪽에 있으면 그쪽 화살표도 빨개집니다. 숫자나 그 화살표를 누르면 가장 가까운 새 탭으로 갑니다(보던 탭은 그대로). 새 줄은 탭 색으로 시작해 서서히 돌아옵니다.

실행 기록은 문장으로 표시됩니다. 테스트는 무엇을 테스트하는지("Testing auth", "Running all the tests"), 빌드는
무엇을 빌드하는지("Building for release"), 배포는 어디로 가는지("Deploying to production"), jobs는 에이전트가 쓴
설명이나 명령의 주된 단계("Running s3.py", "Waiting 60s")로 보여 줍니다. 명령 자체는 실행 상자 맨 위에 나옵니다.

---

## agents

**보여 주는 것**: 맨 위에 에이전트 자신, 그 아래에 지금 일하는 Claude Code 서브 에이전트(백그라운드와
워크플로 에이전트 포함, 서브 에이전트가 띄운 서브 에이전트는 그 아래에 들여 써서). 에이전트마다 두 줄입니다.

```
⠼ add refresh tokens to the auth middleware    opus-5-5
    Bash npm test                         ▰▰▰▱▱ 3/5  2m 16s
⠼ Map the auth tests                            haiku-5-5
    Read src/auth/refresh.test.ts                      40s
```

첫 줄은 이름과 모델, 둘째 줄은 지금 하는 일(서브 에이전트는 실행 중인 도구, 없으면 마지막으로 한 말. 메인 에이전트는 진행 중인 할 일, 없으면 내가 마지막으로 한 요청. 또는
`waiting for you`), 할 일 진행(할 일 목록이 있을 때), 일한 시간입니다. 하나를 고르면 전체가 카드로 나뉘어 보입니다(**activity** 카드: 에이전트가 한 일을 최신순 문장으로. 기본 5개, "▾ more"로 전부(카드 안에서 스크롤). 오래 걸린 명령에는 출력으로 가는 "↗ jobs #n"). 상태와 분당 토큰 수, 잘리지 않은 세션 제목(서브 에이전트는 맡은 작업),
모델과 effort, 컨텍스트 사용량, 토큰, 종류별 도구 사용, 할 일 목록입니다. **team** 카드에는 그 에이전트가 띄운 하위 에이전트(진행 중·완료, 모델과 시간)가 나오고, 목록에서는 하위 에이전트의 하위 에이전트가 가지선(├ └)으로 이어집니다. 할 일에서 enter를 누르면 그 할 일이 나온 대화가 시간순으로 보입니다.

**나타나는 때**: 패널에서 세션이 시작될 때, 그리고 에이전트가 서브 에이전트에게 일을 맡길 때.
[zoetrope](https://github.com/furkankly/zoetrope)처럼 세션의 대화 기록 파일에서 읽습니다.

## jobs

**보여 주는 것**: 테스트도 빌드도 아니면서 오래 걸리는 명령들. 대기 루프, 설치, timeout을 길게 준
스크립트 같은 것들입니다. 무엇을 하려는지(호출 설명), timeout 대비 얼마나 돌았는지(`15s of 2m`),
나오는 대로의 출력을 보여 줍니다. 끝나면 출력과 종료 코드를 남기고, 실패는 빨간색으로 표시합니다.

**나타나는 때**: 그 밖의 명령이 10초를 넘겼을 때(설정 `,`의 jobs 기준 시간: 5·10·30초). 더 짧은 명령은 나타나지 않습니다. 출력은 Claude Code가
그 호출의 출력을 쓰는 파일에서 읽으므로 호출 자체는 바꾸지 않습니다.

## servers

**보여 주는 것**: 이 프로젝트를 위해 떠 있는 개발 서버와 각 서버의 포트, 로그(서버가 쓰는 파일이나 서버가
출력하는 herdr 패널). 로그는 맨 아래를 따라가고, 스크롤하면 `esc`를 누를 때까지 멈춰 있습니다. `o`로
브라우저에서 엽니다.

**나타나는 때**: 프로젝트 안의 프로세스, 또는 같은 herdr 워크스페이스의 패널에서 시작된 프로세스가 포트를
열 때. `npm run dev`, `next dev`, `vite`, `anvil`, `uvicorn`, `flask run`, … 명령은 그대로 두고 탭에
새로움 표시만 붙입니다.

## build · test

**보여 주는 것**: 실행마다 셸에서 보던 색 그대로의 실시간 출력. 상자 맨 위에는 상태 배지(`✓ PASSED`, `✗ FAILED`,
`⠼ RUNNING`)와 실행 위치·걸린 시간·끝난 시각이, 테스트는 실행기의 요약에서 읽은 통과·실패 수 막대가 나오고,
로그 왼쪽에는 줄 번호와 함께 오류 줄은 빨간 막대, 경고 줄은 노란 막대가 붙습니다. jobs와 deploy도 같은 모양입니다.

**나타나는 때**: 에이전트가 실행할 때.

- 테스트: `npm/pnpm/yarn test[:x]`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `bun test`,
  `deno test`, `forge test`, `make`/`just test`, `./test.sh` 같은 스크립트
- 빌드: `npm/pnpm/yarn run build[:x]`, `tsc`, `next build`, `vite build`, `go build`,
  `cargo build`/`check`, `forge build`, `make`/`just build`, `./build.sh` 같은 스크립트

단순한 호출(`[cd DIR &&] [VAR=val] [time|timeout N|env] [npx|pnpm|…] RUNNER [args]`, 여기에 `2>&1`과
`| tail/head -n N` 하나까지)은 deck 안에서 실행되고, 에이전트는 여전히 일반 텍스트와 실제 종료 코드를
받습니다. 체인이나 파이프 안에 있으면(`git status; npm test | grep FAIL`) 쓴 그대로 실행되고, 끝난 뒤
나타납니다.

## git

**보여 주는 것**: 저장소를 바꾼 명령 전부. 단계마다 한 줄(`git add · git commit "Fix it" · git push`),
실행된 브랜치, 남긴 커밋을 보여 주고, 커밋은 메시지 전체를 보여 줍니다. 목록 테두리에는 지금의 저장소
상태가 나옵니다.

```
╭─ runs · 12 ─────────────── main ↑2 · 3 changed ─╮
```

브랜치, 푸시하지 않은 커밋(`↑`)과 받지 않은 커밋(`↓`), 커밋하지 않은 파일 수(없으면 `clean`)입니다.

**나타나는 때**: `git`이 들어 있는 명령이 실행되어 무언가를 바꿨을 때. `git status`, `git log` 같은 조회는
제외합니다.

## deploy

**보여 주는 것**: 배포마다 출력과 종료 코드.

**나타나는 때**: 실제 배포가 실행됐을 때. `vercel`, `railway up`, `netlify deploy`, `fly deploy`,
`wrangler deploy`, `firebase deploy`, `gcloud run deploy`, `terraform apply`, `kubectl apply`,
`helm upgrade`, `forge script --broadcast` 등([전체 목록](../bin/classify)). `vercel ls`, `fly status`
같은 조회는 제외합니다.
