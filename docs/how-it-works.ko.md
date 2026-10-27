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
- `$crew`: 메인 턴이 도는 동안, 그리고 아직 도는 서브에이전트마다(PM의 워커 같은 중첩 포함) 세는 스피너와 개수(`⠋ 2`). 서브에이전트는 SubagentStart/SubagentStop 훅으로 셉니다(`agent_id`별 표식을 창의 상태 폴더에 두고, SessionStart에서 비우고, 3시간이 지나면 버림). 오래 조용한 도구 호출 중에도 계속 셉니다.
- `$tree1`..`$tree3`: 트리 안내선(`├`, 마지막으로 보이는 행은 `└`, 빈 행은 비움). 별도 토큰이라 글자와 다른 색을 줄 수 있습니다. `STEADING_SIDEBAR_TREE=0`이면 끕니다.
- `$wstree`, `$wsrepo`: Spaces 패널 둘째 행용 워크스페이스 토큰(herdr 기본 `branch`는 안내선을 못 붙임). `└`와 `$repo`와 같은 글(`$repostate`는 `$wsrepostate`). 한 워크스페이스에 에이전트가 여럿이면 마지막 보고가 보입니다.
- `$wsrun`, `$wstree2`: Spaces 패널 셋째 행, 워크스페이스에서 돌아가는 것: 개발 서버의 포트(deck의 servers 섹션이 찾는 그대로)와 아직 도는 긴 작업, `▶ :3000 :5173 · ⏳ 1 job`. 아무것도 안 돌면 비어서 행이 사라집니다. 보이는 동안 `$wstree`는 `├`가 됩니다. `$wstree`, `$wsrun`, `$wstree2`는 수명 없이 한 출처로 함께 보고합니다(herdr는 마지막 보고가 만료되면 토큰을 통째로 지우므로, 수명을 따로 두면 안내선만 `├`로 남습니다). 서버는 훅 없이도 멈추므로, 무언가 돌면 `bin/sidebar.py`가 워크스페이스마다 하나씩 `bin/steading_run.py`를 띄웁니다. 10초마다 다시 계산하다가 아무것도 안 돌면 `$wsrun`·`$wstree2`를 지우고 `$wstree`를 `└`로 바꾼 뒤 끝납니다(워크스페이스가 없어져도 끝남). 세션이 바뀌어도 계속 돕니다.

`~/.config/herdr/config.toml`의 행 구성으로 herdr agents 목록에 보이게 합니다.

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], [{ token = "$wstree", fg = "#ffffff" }, { token = "$wsrepo", dim = true }, { token = "$wsrepostate", dim = true }],
        [{ token = "$wstree2", fg = "#ffffff" }, { token = "$wsrun", fg = "#98c379" }]]

[ui.sidebar.agents]
rows = [
  ["state_icon", { token = "workspace", bold = true }, "tab"],
  [{ token = "$tree1", fg = "#ffffff" }, { token = "$repo", dim = true }, { token = "$repostate", dim = true }],
  [{ token = "$tree2", fg = "#ffffff" }, { token = "$model", dim = true }, { token = "$ctx", dim = true }, { token = "$ctxhot", fg = "#e06c75", bold = true }],
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
