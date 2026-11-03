# 동작 방식

[English](how-it-works.md) · **한국어** · [← README](../README.ko.md)

```mermaid
flowchart LR
  A[Claude Code<br/>Bash tool] -- PreToolUse --> H[bin/hook]
  H -- test / build:<br/>rewrite to --> R[bin/run]
  H -- anything else --> J[bin/job]
  A -- PostToolUse(Failure) --> C[bin/record]
  R -- bin/ptyrun --> S[(TMPDIR/steading/&lt;agent&gt;/)]
  J --> S
  C --> S
  R & C -- bin/pane --follow --> V[bin/viewer.py<br/>the deck]
  V -- reads --> S
  V -- bin/servers --> L[lsof]
  V -- transcripts --> T[(~/.claude/projects)]
```

- `bin/classify`는 명령줄을 셸 토큰 단위로 읽습니다. 무엇을 실행하는지(test, build, deploy, git 쓰기),
  보여 줄 핵심 명령(`cd x; env -u A pnpm test | tail` → `pnpm test`), 실시간으로 실행해도 되는지를
  판단합니다. 두 훅이 모두 이것을 씁니다.
- `bin/hook`은 Bash 호출이 무엇인지 판단합니다. 테스트와 빌드는 `bin/run`으로 바꿔 실행하고(승인됨,
  아래 참고), 개발 서버는 열린 deck을 `servers`로 바꾸기만 합니다. 나머지는 job으로 기록하고,
  명령이 시작되면 `bin/job`이 Claude Code가 그 출력을 쓰는 파일을 찾아 연결합니다.
- `bin/run`은 명령을 의사 터미널(`bin/ptyrun`)에서 실행하고, 실행 기록을
  `$TMPDIR/steading/<agent pane>/<kind>/runs/<n>/`에 쓴 뒤, 일반 텍스트 출력과 종료 코드를 돌려줍니다.
- `bin/record`는 Claude가 실행한 뒤 git 명령, 배포, `bin/run`을 거치지 않은 테스트와 빌드를 기록하고,
  job이 어떻게 끝났는지 남깁니다.
- `bin/open`은 Claude Code 세션에 단순한 명령으로 실행하라는 안내를 추가합니다. 세션이 새 패널에서 다시
  열렸거나 `/tmp`가 비워져 deck이 비어 있으면, `bin/restore`가 세션 대화 기록을 `bin/record`에 다시
  넣어 채웁니다.
- `bin/pane`은 에이전트마다 deck을 한 번 열고 어느 탭을 보여 줄지 알려 줍니다. 실행에서 부를 때
  (`--follow`)는 이미 열린 deck의 탭만 바꿉니다.
- `bin/deck`은 herdr 쪽입니다. `toggle`은 단축키용, `auto`는 herdr의 `pane.agent_detected` 이벤트용,
  `flip`은 `L`용입니다.
- `bin/viewer.py`는 그 실행 기록 디렉터리로 deck을 그리고, 파일이 수정되면 스스로 다시 시작합니다.

## 설정

| 변수 | 기본값 | 용도 |
|---|---|---|
| `STEADING_SOURCE` | `levx-me/steading` | `bin/install-claude`가 Claude Code 마켓플레이스를 추가할 위치(경로 또는 `owner/repo`) |
| `TMPDIR` | `/tmp` | 실행 기록(`$TMPDIR/steading`)의 상위 디렉터리 |
| `STEADING_PYTHON` | 찾은 가장 새로운 `python3` | 훅, deck, 헬퍼가 쓰는 Python |
| `STEADING_CACHE` | `~/.cache/steading` | 파싱한 대화 기록을 저장하는 곳 |

deck에서 실행되는 명령에는 `CI=1`(watch 모드 끔)과 `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`,
`PY_COLORS=1`, `CARGO_TERM_COLOR=always`가 설정됩니다.

## herdr 사이드바

훅(`bin/sidebar`, 도구 호출마다와 턴이 끝날 때)이 각 에이전트의 저장소 상태와 컨텍스트 사용량을
herdr에 pane 토큰으로 알려 줍니다. deck이 열려 있지 않아도 됩니다.

- `$repo`: 브랜치, 안 올린 커밋(`↑`)과 안 받은 커밋(`↓`).
- `$repostate`: 커밋 안 한 파일 수(`3 changed`) 또는 `clean`. 별도 토큰이라 색을 따로 줄 수 있습니다.
  git 저장소 밖의 폴더면 `$repo`는 ` no git`(폴더 아이콘)이고 `$repostate`는 비어 있습니다.
- `$model`: 모델.
- `$ctx`: 컨텍스트 사용량(막대와 퍼센트). 80%부터는 `$ctxhot`으로 바뀌어 행 구성에서 색을 줄 수 있습니다.
- `$tasks`: 에이전트의 할 일 목록(TaskCreate/TaskUpdate), 막대와 완료/전체.
- `$usage`: 세션의 CPU와 메모리. claude 프로세스와 그 아래 전부(MCP 서버, node, 셸)를 합친 값(` 15% 0.6G`).
  `bin/usage.py`가 맡고, 컴퓨터에 하나만 돕니다(데몬이 돌림, 아래 참고). 10초마다 `ps`를 한 번 불러 모든 창을 계산하고,
  CPU는 5% 단위, 메모리는 0.1 GB 단위로 반올림해 바뀔 때만 보고하므로 사이드바가 거의 다시 그려지지 않습니다.
  claude가 끝난 창에서는 지우고, Claude를 돌리는 창이 없으면 끝납니다.
- `$crew`: 메인 턴이 도는 동안, 그리고 아직 도는 서브에이전트마다(PM의 워커 같은 중첩 포함) 세는 스피너와 개수(`⠋ 2`). 서브에이전트는 대화 기록이 아니라 Claude Code의 훅으로 셉니다(Claude Code는 턴이 끝나야 기록을 쓰므로, 10분 동안 생각하는 에이전트는 조용합니다). `bin/sidebar`가 SubagentStart(일하는 중), SubagentStop(끝남, 에이전트 팀의 팀원은 대기), TeammateIdle(대기), 새 프로세스(SessionStart의 startup·resume·clear. compact는 서브에이전트가 계속 돌므로 제외)를 훅의 나머지 일보다 먼저 `$TMPDIR/steading/sessions/<세션 id>.log`에 시각과 함께 한 줄씩 적어서, 늦게 읽힌 줄이 더 새로운 줄을 덮지 않습니다. `$crew`와 덱의 agents 섹션이 같은 `bin/subagents.py`로 이 기록을 읽으니 둘은 늘 같은 수를 보입니다. 멈춤 없이 3시간이 지난 시작은 비정상 종료로 보고, 훅이 한 번도 알리지 않은 서브에이전트(기록 전에 시작한 세션)는 대화 기록이 움직이는 동안 셉니다. 턴은 끝났지만 스스로 시작한 일이 남은 서브에이전트(대화 기록에 아직 task-notification이 오지 않은 백그라운드 명령, 또는 아직 있는 자기 하위 에이전트)는 일하는 중이 아니라 기다리는 중입니다. 덱은 `◷`로 보여 주고 `$crew`는 세지 않습니다. 그런 명령도 `bin/subagents.py`가 찾습니다. 대화 기록의 바이트에서 도구 결과의 `backgroundTaskId`와 알림의 `<task-id>`를 맞춰 보며, 지난번 이후 더해진 줄만 읽습니다. 턴이 끝난 에이전트는 다시 돌기 전까지 알림을 받지 못하므로, Claude Code가 명령의 출력 파일 끝에 쓰는 `[exited with code N]`으로도 끝난 것으로 보고, meta에 `finished`가 적힌 에이전트(보고를 넘김)는 아무것도 기다리지 않습니다.
- `sessions/<세션 id>.files`: 세션의 에이전트가 하는 Read, Edit, Write, NotebookEdit를 한 줄씩, 사이드바 훅이 다른 일보다 먼저 `bin/files.py`로 덧붙입니다(새 프로세스 없음). 덱의 files 섹션이 이를 읽습니다.
- `$tree1`..`$tree3`: 트리 안내선(`├`, 마지막으로 보이는 행은 `└`, 빈 행은 비움). 별도 토큰이라 글자와 다른 색을 줄 수 있습니다. `STEADING_SIDEBAR_TREE=0`이면 끕니다.
- `$wstree`, `$wsrepo`: Spaces 패널 둘째 행용 워크스페이스 토큰(herdr 기본 `branch`는 안내선을 못 붙임). `└`와 `$repo`와 같은 글(`$repostate`는 `$wsrepostate`). 한 워크스페이스에 에이전트가 여럿이면 마지막 보고가 보입니다.
- `$wsrun`, `$wstree2`: Spaces 패널 셋째 행, 워크스페이스에서 돌아가는 것: 개발 서버의 포트(deck의 servers 섹션이 찾는 그대로)와 아직 도는 긴 작업, `▶ :3000 :5173 · ⏳ 1 job`. 아무것도 안 돌면 비어서 행이 사라집니다. 보이는 동안 `$wstree`는 `├`가 됩니다. `$wstree`, `$wsrun`, `$wstree2`는 수명 없이 한 출처로 함께 보고합니다(herdr는 마지막 보고가 만료되면 토큰을 통째로 지우므로, 수명을 따로 두면 안내선만 `├`로 남습니다). 서버는 훅 없이도 멈추므로, 무언가 돌면 데몬이 워크스페이스마다 하나씩 `bin/steading_run.py`를 돌립니다. 10초마다 다시 계산하다가 아무것도 안 돌면 `$wsrun`·`$wstree2`를 지우고 `$wstree`를 `└`로 바꾼 뒤 끝납니다(워크스페이스가 없어져도 끝남). 세션이 바뀌어도 계속 돕니다.

### 데몬과 캐시

- `bin/steadingd.py`는 컴퓨터에 하나만 도는 데몬입니다(`$TMPDIR/steading/daemon.pid`, 그리고 권한 0600의 HTTP 소켓 `daemon.sock`). `usage`, `$wsrun` 갱신, crew, System 탭의 샘플러(덱이 그 탭을 보여 주는 동안)를 스레드로 돌려서 각각 프로세스를 따로 띄울 때보다 가볍습니다. 첫 훅이 띄우고, 스스로 끝나지 않으며, 자기가 불러온 `bin/` 모듈이 바뀌면 다시 실행하고 그 뒤에 헬퍼도 다시 시작합니다(`daemon.helpers.json`, 오류는 `daemon.log`).
- `bin/sidebar`는 이벤트를 `curl --unix-socket`으로 데몬에 넘기고, 서브에이전트 기록은 훅이 끝나기 전에 써집니다. 데몬이나 `curl`이 없으면 예전처럼 훅이 스크립트를 직접 돌리고, 헬퍼도 각자 프로세스로 돕니다.
- 스크립트는 가장 새로운 Python으로 돕니다: `$STEADING_PYTHON`, Homebrew, `/usr/local`, 그다음 `python3`(`bin/py.sh`, `bin/py`). 3.9부터 3.15까지 됩니다.
- `bin/transcripts.py`가 대화 기록을 파싱하고, 결과를 `$STEADING_CACHE`(없으면 `${XDG_CACHE_HOME:-~/.cache}/steading`, 권한 0700)에 저장합니다. 캐시 키가 파서 자신의 소스라서 덱의 그리기 코드를 고쳐도 유지됩니다. 14일간 안 쓴 항목은 지웁니다. 535 MB 대화 기록 옆에서 덱을 다시 시작해도 5.8초가 아니라 0.2초면 준비됩니다.

`~/.config/herdr/config.toml`의 행 구성으로 herdr agents 목록에 보이게 합니다.

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], [{ token = "$wstree", fg = "#ffffff" }, { token = "$wsrepo", dim = true }, { token = "$wsrepostate", dim = true }],
        [{ token = "$wstree2", fg = "#ffffff" }, { token = "$wsrun", fg = "#98c379" }]]

[ui.sidebar.agents]
rows = [
  ["state_icon", { token = "workspace", bold = true }, "tab"],
  [{ token = "$tree1", fg = "#ffffff" }, { token = "$repo", dim = true }, { token = "$repostate", dim = true }],
  [{ token = "$tree2", fg = "#ffffff" }, { token = "$model", dim = true }, { token = "$ctx", dim = true }, { token = "$ctxhot", fg = "#e06c75", bold = true },
   { token = "$usage", dim = true }],
  [{ token = "$tree3", fg = "#ffffff" }, { token = "$tasks", dim = true }],
]
```

### 정확한 컨텍스트 퍼센트 (선택)

컨텍스트 창 크기는 트랜스크립트에 없어서 `$ctx`와 덱의 컨텍스트 막대는 추정값입니다
(200K, 모델 이름에 `[1m]`이 있거나 사용량이 200K를 넘으면 1M). Claude Code는 상태줄 명령에 실제 값을
넘겨 줍니다. 상태줄 명령이 그 JSON을 세션별로 저장하면 덱과 사이드바가 그 값을 씁니다(10분 이내일 때).
상태줄 명령에 다음을 추가하세요:

```sh
input=$(cat)   # 상태줄의 stdin
sid=$(printf %s "$input" | jq -r .session_id); d="${TMPDIR:-/tmp}/steading/statusline"
mkdir -p "$d" && printf %s "$input" > "$d/$sid.json.$$" && mv "$d/$sid.json.$$" "$d/$sid.json"
```

## 보안 참고

- deck으로 넘긴 테스트와 빌드는 Claude Code에 **승인됨**(`permissionDecision: "allow"`)으로 돌려주므로
  권한을 묻지 않습니다. deny와 ask 규칙은 그대로 적용됩니다. `npm test`와 `npm run build`는
  `package.json`에 적힌 것을 그대로 실행합니다. 자동 승인을 원하지 않으면 `bin/hook`의 패턴에서 빼세요.
- git 명령, 배포, job은 Steading이 바꾸거나 승인하지 않습니다.
- 실행 로그는 `$TMPDIR`에만 남고 컴퓨터 밖으로 나가지 않습니다.

## 개발

```sh
git clone git@github.com:levx-me/steading.git && cd steading
claude plugin marketplace add "$PWD" && claude plugin install steading@steading
herdr plugin link "$PWD"
bun test
```

체크아웃한 저장소로 플러그인을 설치하면 `bun test` 자체도 deck에서 실행됩니다. deck의 모양이 바뀌면
README 미리보기를 다시 만드세요: `python3 docs/demo.py > docs/demo.svg`.
