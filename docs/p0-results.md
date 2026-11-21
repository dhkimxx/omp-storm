# OMP Storm P0 스파이크 결과

- **일시:** 2026-11-20
- **환경:** macOS arm64, omp 19.0.1(바이너리). 소스 근거는 `@oh-my-pi/*` 19.0.0, 하네스 실행은 bun 1.4.4.
- **방법:**
  - **Q1~Q5 실행 경로:** [spikes/p0](../spikes/p0/README.md) 하네스로 실측했다.
    - omp를 격리 프로필(`--profile storm-p0`)에서 가짜 OpenAI 호환 서버에 연결하고, 시나리오마다 RPC·ACP·print·TUI 모드로 새 프로세스를 띄웠다.
    - 유료 모델 호출은 0회다.
    - 아래 값은 하네스를 고친 뒤 전체 시나리오 20개를 한 번에 다시 돌린 결과다.
  - **Q5~Q9 일부:** omp 소스와 이 Mac의 사용자 데이터(`stats.db`, 카탈로그 캐시)를 읽기 전용으로 분석했다.

## 요약

| # | 질문 | 결론 | 계획서 |
|---|---|---|---|
| 1 | `sendUserMessage`로 키워드 계약을 넘길 수 있나 | `deliverAs` 없이 보낼 때만 notice가 붙는다. `followUp`·`steer`는 전달되지만 notice가 없다 | 5장, 6장 |
| 2 | 스폰 훅으로 모델 강제·차단이 되나 | task·eval 모두 된다. `agentModelOverrides`보다 우선하고, 기본 에이전트도 훅을 거친다 | 5장, 6장 |
| 3 | 플러그인 `agents/`의 역할 에이전트 | 발견과 이름 스폰 모두 된다. 단 프로젝트·사용자 정의가 덮어쓴다 | 6장, 12장 |
| 4 | 도구 안 승인 UI | TUI·RPC·폼 지원 ACP에서 동작한다. 나머지는 자동 미승인이고, `hasUI`로는 구분할 수 없다 | 5장, 6장, 11장 |
| 5 | 예산 상한 | omp 세션 상한이 유일한 확실한 상한(자식까지 막음)이다. 확장용 공개 API는 없다 | 11장 |
| 6 | 승인 기록 형식 | repo-id는 git common dir 해시, 승인은 설정 해시별, 해시는 JCS 정규화 SHA-256 | 7장 |
| 7 | omp가 `.omp/storm/`을 읽나 | 읽지 않는다 | 7장 |
| 8 | 30~90일 이력 경로 | `stats.db` 읽기 전용 직접 조회. 신선도와 gc 삭제에 대비해야 한다 | 8.1, 9.1 |
| 9 | 카탈로그 공백·계열 키 | 계열 키 `class/등급@revision`, 가격 계층 $0.01/$0.06, `int`·`tps` 대체 순서 | 9.1, 9.2, 9.4 |

## Q1. 작업 인계와 매직 키워드

| 경로 | 시나리오 | 전달 | notice |
|---|---|---|---|
| 사용자가 직접 입력(기준선) | `q1-typed` | ✓ | ✓ |
| 유휴 상태에서 `sendUserMessage(text)` | `q1-idle` | ✓ | ✓ |
| 스트리밍 중 `sendUserMessage(text)`(steer로 큐) | `q1-auto` | ✓ | ✓ |
| `agent_end` 뒤 `sendUserMessage(text)` | `q1-deferred` | ✓ | ✓ |
| `deliverAs: "followUp"` | `q1-followUp` | ✓ | ✗ |
| `deliverAs: "steer"` | `q1-steer` | ✓ | ✗ |

- **notice 위치:** 사용자 메시지 바로 앞에 숨은 사용자 메시지로 붙는다.
- **`agent_end` 시점:** 이 시점에 `ctx.isIdle()`이 이미 `true`였다.
- **근거:** `prompt()`는 `synthetic`이 아닐 때 notice를 만든다(`session/agent-session.ts:9280`). `sendUserMessage`는 `deliverAs`가 지정되면 `prompt()`를 거치지 않고 `#queueUserMessage`를 직접 부르며 notice를 넘기지 않는다(`:11552`). notice가 붙으려면 `orchestrate`는 `task`가, `workflowz`는 `eval`과 `task`가 켜져 있어야 한다(`modes/magic-keywords.ts`).

**결정**
- `/storm <작업>` 명령에서는 `await ctx.waitForIdle()` 뒤 `sendUserMessage(text)`를 부른다. (v0.4에서 대체됨: 명령은 실행을 시작하지 않고 요청을 메인 LLM에 넘긴다. 실행은 `storm` 도구 경로로만 `agent_end` 뒤 시작한다.)
- `storm` 도구에서는 실행 요청을 보관했다가 `agent_end`에서 보낸다. 스트리밍 중 steer 경로도 notice는 붙지만, steer는 진행 중인 도구 묶음을 끊을 수 있어 쓰지 않는다.
- `followUp`·`steer`는 키워드 인계에 쓰지 않는다.

## Q2. 스폰 훅

| 시나리오 | 훅 입력(`agent`, `invocationKind`, `modelRole`, `patterns`) | 훅 결과 | 자식이 쓴 모델 |
|---|---|---|---|
| `q2-task` | storm-implementer, task, -, fake/main | `model: [approved-a, approved-b]` | approved-a |
| | storm-reviewer, task, -, fake/main | `block` | 요청 없음. async 작업 실패 알림에 사유가 담김 |
| `q2-eval` | storm-implementer, eval, -, fake/main | `model` | approved-a |
| | storm-reviewer, eval, -, fake/main | `block` | 요청 없음. `wait()` 결과가 `RuntimeError('storm: storm-reviewer is not approved')` |
| `q2-override-observe`(override = override-x) | storm-implementer, task, -, fake/override-x | 없음 | override-x |
| `q2-override-route`(같은 override) | 위와 같음 | `model` | approved-a |
| `q2-builtin` | task, task, -, fake/main · scout, task, smol, fake/main | 없음 | main |

- **호출 단위:** 훅은 실제 스폰마다 한 번 호출되고 `spawnKey`가 온다. task는 항목 이름, eval은 생성된 라벨이다. 소스상 "자식 하나당 정확히 한 번"을 보장한다(`task/structured-subagent.ts:647`).
- **중첩 스폰:** 서브에이전트 세션에도 확장이 로드된다. 자식마다 `session_start`(mode=print, hasUI=false)가 기록됐으니 중첩 스폰에도 같은 훅이 걸린다.
- **기능 확인 프로브:** 처음 쓰는 커스텀 모델에 omp가 reasoning 지원을 확인하는 프로브 요청을 보냈다("What is 17 times 23?" 최대 7건). 카탈로그에 등록된 모델에서도 그러는지는 [미검증]이다.

**결정**
- `storm-<역할>`은 승인된 모델 목록으로 교체한다. `task.agentModelOverrides`는 바꿀 필요가 없다.
- Storm 역할이 아닌 에이전트는 Storm 실행 중에만 다룬다.
  - 요청 모델이 승인 목록 안이면 허용한다.
  - 밖이면 config가 지정한 대체 역할의 모델로 바꾸고, 대체 역할이 없으면 차단한다.
  - Storm 실행 밖에서는 관여하지 않는다.

## Q3. 역할 에이전트 발견과 스폰

| 방식 | task 도구 목록 | 이름으로 스폰 | 훅 로드 |
|---|---|---|---|
| `-e <플러그인 디렉터리>` | storm-implementer, storm-reviewer | ✓ (자식 프롬프트에 플러그인 정의가 쓰임) | ✓ |
| `omp plugin link` 후 `-e` 없이 실행 | ✓ | ✓ | ✓ |
| 프로젝트에 `.omp/agents/storm-implementer.md`가 있을 때 | ✓ | 프로젝트 정의가 쓰임 | ✓ |

- **link/uninstall:** `omp plugin link`와 `omp plugin uninstall`은 모두 성공했다(`✔ Linked omp-storm-spike`, `✔ Uninstalled omp-storm-spike`).
- **탐색 우선순위:** 프로젝트 > 사용자 > 확장 패키지 > 플러그인 > 기본 탑재(`task/discovery.ts:77-81`).
- **`/agents` 허브:** 화면 표시는 확인하지 않았다. task 도구 목록이 같은 탐색 결과를 쓴다고 보고 있다 [추정].

**결정:** 프로젝트·사용자 `agents/`의 `storm-*` 정의를 감지해 승인 범위(`scope.shadowedAgents`)에 넣는다. 승인되지 않은 가림 정의가 있으면 그 역할의 스폰을 막는다. 스폰 훅 입력에는 정의 출처가 없어서, Storm이 디렉터리를 직접 검사해야 한다.

## Q4. 도구 안 승인 UI

| 모드 | 시나리오 | `hasUI` | `ctx.mode` | select | confirm |
|---|---|---|---|---|---|
| TUI | `q4-tui` | true | tui | 승인 | true |
| RPC | `q4-rpc` | true | rpc | 승인 | true |
| ACP, 클라이언트가 `elicitation.form`을 알림 | `q4-acp-form` | true | rpc | 승인 | true |
| ACP, 폼 미지원 | `q4-acp-noform` | true | rpc | null | false |
| RPC `--no-ui` | `q4-rpc-noui` | false | rpc | null | false |
| print | `q4-print` | false | print | null | false |

- **모드별 전달 방식:** RPC는 `extension_ui_request`(select, confirm)를 보내고 클라이언트 응답을 기다린다. ACP는 `elicitation/create`(form) 요청을 보낸다. 클라이언트가 폼을 지원하지 않으면 요청 없이 바로 `undefined`·`false`를 돌려준다(`modes/acp/acp-agent.ts:814-835`).
- **TUI 실측 방법:** expect로 TUI의 터미널 질의(DA1, OSC 11)에 응답했다. 새 프로필의 첫 실행 마법사는 `setupVersion: 3`으로 껐다.

**결정**
- `select`가 정확히 "승인"을 돌려줄 때만 승인으로 기록한다. `hasUI`로는 판단하지 않는다.
- 승인할 수 없는 환경에서는 제안을 보관하고, 승인할 수 있는 곳(TUI 등)을 안내한다.

**남은 확인 — Orca 채팅:** Orca는 에이전트를 채팅(`structured`)이나 터미널로 띄운다(`orca agent launch`). Orca 채팅이 ACP 클라이언트로서 `elicitation.form`을 알리는지는 확인하지 못했다. 알리지 않으면 Orca 채팅에서는 승인할 수 없다(자동 미승인). Orca 터미널에서 도는 omp는 TUI이므로 승인할 수 있다.

## Q5. 예산 상한

**실측(`q5-maxcost`):** 가짜 `priced` 모델은 요청당 $0.11이고, 상한은 `--max-cost 0.2`로 걸었다.
- 메인 세션 요청 2건($0.22)으로 상한을 넘었다.
- 그 뒤 시작한 자식 2개는 첫 모델 요청이 거부되어 약 80~90ms 만에 실패했다("Cost cap reached: this session spent $0.22 of its $0.20 cap"). 서브에이전트도 세션 상한 게이트를 함께 쓴다는 뜻이다.

**소스**
- 설정은 `session.maxCost`·`session.warnCost`다(`session/settings.ts:1764-1778`).
- 상한은 모델 요청 직전마다 검사한다(`session/cost-gate.ts:90-98`). 그래서 진행 중인 요청은 상한을 넘겨 끝날 수 있다.
- 서브에이전트에도 같은 게이트가 전달된다(`task/structured-subagent.ts:755`).

**확장에서 할 수 있는 것**
- 상한을 설정하거나 누계를 읽는 공개 API는 없다. `ExtensionContext`에 비용 게이트가 없다.
- `ctx.sessionManager.getUsageStatistics().cost`는 끝난 task만 반영한다.
- 진행 중 비용은 task의 `tool_execution_update` progress에서 보인다. eval 자식의 진행 중 비용 이벤트는 [미검증]이다.

**결정:** 계획서 11장의 세 겹(스폰 차단 + 자체 누계 경고 + `--max-cost` 권고)으로 지킨다.
- 비공개 설정 레지스트리로 상한을 쓰는 방법은 쓰지 않는다. 내부 API이고, "omp 설정을 바꾸지 않는다"는 원칙에도 어긋난다.
- upstream에 읽기 전용 비용 상태와 세션 범위 상한 API를 제안한다.
- config 형식은 `"budget": {"perRunUsd": 5, "warnAtUsd": 4, "onExceed": "block-spawns"}`로 하고(`onExceed`는 `"stop"`도 가능), 설정 해시에 포함한다.

## Q6. 승인 기록, 저장소 식별, 설정 해시

**git 실측(임시 저장소)**
- **worktree:** worktree끼리 `--git-common-dir`이 같아서 승인을 공유한다.
- **따로 잡히는 경우:** remote가 없는 복사본, fork 클론, 저장소 이동은 모두 다른 값이 나온다.
- **경로 형식:** `--path-format=absolute`가 없으면 상대 경로가 나온다.
- **remote URL:** URL 안의 자격 증명을 그대로 출력한다.

**해시 실측**
- 줄바꿈, 들여쓰기, 키 순서만 다른 파일은 정규화 해시가 같았다. 모델 배열 순서를 바꾸면 해시가 달라졌다(시도 순서는 의미가 있으므로 맞는 결과다).
- `JSON.parse`는 중복 키를 오류 없이 마지막 값으로 처리한다. 그래서 중복 키는 엄격한 파서로 거부한다.

**에이전트 디렉터리:** `pi.pi.getAgentDir()`는 `--profile`/`OMP_PROFILE` > `PI_PROFILE` > `PI_CODING_AGENT_DIR` > `~/.omp/agent` 순서를 따랐다.

**결정:** 계획서 7장. 승인 기록 예:

```json
{
  "schema": "storm.approval/v1",
  "approvalId": "apr_…",
  "status": "active",
  "repoId": "git-omp-storm-3f9a0c1e…",
  "configHash": "jcs-sha256:7d0b…",
  "rawSha256": "a41c…",
  "approvedAt": "2026-11-20T03:12:45Z",
  "approvedVia": { "mode": "tui" },
  "versions": { "omp": "19.0.1", "storm": "0.1.0", "configSchema": 1 },
  "scope": {
    "providers": ["anthropic", "openai-codex"],
    "roles": { "implementer": { "agent": "storm-implementer", "models": ["anthropic/claude-sonnet-5-5"] } },
    "budget": { "perRunUsd": 5, "warnAtUsd": 4, "onExceed": "block-spawns" },
    "runtime": "omp",
    "shadowedAgents": []
  },
  "supersedes": null,
  "expiresAt": null
}
```

- 판정은 `configHash`로만 한다. `rawSha256`은 감사용이다.
- 계정 식별자와 토큰은 어느 필드에도 넣지 않는다.
- 현재 형식은 `src/types.ts`의 `ApprovalRecord`가 정한다.

## Q7. `.omp/storm/` 충돌

- **소스:** omp는 프로젝트 `.omp/` 아래에서 정해진 이름(`config.yml`, `extensions/`, `skills/`, `commands/`, `agents/`, `rules/`, `prompts/` 등)만 읽는다. `storm`은 그 목록에 없다.
- **실측:** `.omp/storm/`에 config.json, state, `.ts`, `extensions/`, `skills/`, `commands/`를 넣어도 설정, 확장 로드, 명령·스킬 목록이 바뀌지 않았다.
  - 대조군: 같은 내용을 정식 위치에 두면 반영됐다.
  - `.omp/storm/.gitignore`(`/state/`)만으로 state가 git에서 빠졌다.

**결정:** 계획서 7장 구조를 확정한다. 역할 에이전트는 플러그인 `agents/`에만 둔다. `.omp/storm/agents/`는 탐색되지 않는다.

## Q8. 30~90일 사용 이력

| 경로 | 필드 충족 | 판단 |
|---|---|---|
| `stats.db` 직접 읽기(확장 안 `bun:sqlite` 읽기 전용) | 전부 충족: 모델×agent_type, purpose 제외, p50/p90, 토큰·비용, 폴더, 임의 기간 | **채택.** 90일 조회 0.3초 미만 |
| 대시보드 HTTP API(`?range=`) | 평균만 있음, 부가 호출이 섞임, agent_type 분리 없음 | 탈락. 브라우저를 자동으로 열고 서버가 상주한다 |
| `omp stats --json` | 24시간 고정 집계 | 탈락 |
| upstream `--range` 추가(약 10줄) | API와 같은 집계 | 기여 후보. 의존하지 않는다 |
| `@oh-my-pi/omp-stats` import | 호스트 번들에 없다. 사본을 쓰면 다른 버전의 마이그레이션이 사용자 DB에 돌 위험이 있다 | 탈락 |

- **신선도:** 실행 중인 omp는 세션 파일만 쓴다. stats.db는 `omp stats`, 대시보드, `/usage`가 돌 때만 갱신된다. 실측했을 때 최신 행이 약 2.5시간 늦었다.
- **보존:** `omp gc --apply`가 30일 넘은 세션의 stats 행을 지운다(`cli/gc-cli.ts:1633,1920`).
- **DB 특성:** WAL 모드라 읽기가 쓰기를 막지 않는다. 스키마 버전 번호는 따로 없지만, `messages` 테이블은 지금까지 컬럼을 더하는 마이그레이션만 있었다.

**결정:** 계획서 9.1.
- 경로는 `getStatsDbPath()`로 얻고 읽기 전용으로 연다. `immutable=1`은 쓰지 않는다.
- 필수 컬럼을 검사한다. 분위수는 처음에 윈도우 함수로 구하기로 했으나, 구현은 단순 조회 뒤 TS에서 계산한다(`src/history/stats.ts`).
- 결과에 데이터 기준 시각을 표시하고, 필요하면 `omp stats --summary`로 갱신한다.
- 일 단위 집계를 따로 보관한다.

## Q9. 카탈로그 공백과 모델 계열 키

**계열 키 `class/등급@revision`**
- class와 revision은 카탈로그 `identity`에서 가져온다. revision이 없으면 이름에서 만든다.
- 등급은 모델 이름에서 브랜드어·버전 숫자·경로 변형어를 지우고 남은 토큰이다.
- `-fast`·`-ultrafast`·`-highspeed`·`-preview`·날짜 스냅숏·`:thinking`은 같은 키 안의 경로 변형으로 따로 기록한다.
- `identity.family`·`logicalId`와 `ctx.models.family()`(class와 같은 값)는 쓰지 않는다.
- 카탈로그 쪽 접미사 처리에는 오탐이 있다(`mistral-medium`을 effort 변형으로 접음). 그래서 omp 내부 함수를 쓰지 않고 플러그인에서 따로 구현한다(약 80줄).

**평가**
- **카탈로그 전체:** 4,042행(버전별 캐시 중복 제거 후)이 1,475개 그룹이 됐다. 이 중 520개는 Provider 2곳 이상에 걸친다. 잘못 합쳐진 사례는 휴리스틱 검사로 찾지 못했다.
- **사용자 30일 이력:** 19쌍이 13개 키로 묶였다. DeepSeek V4.1 Flash의 세 경로가 합쳐졌고, GPT 등급 terra·sol·luna·astra는 분리됐다.

**`int`**
- `int`는 계열이 아니라 경로별 값이다. 키 181개 중 63개가 경로마다 다른 값을 가졌다.
- DeepSeek의 39.5는 번들 카탈로그가 날짜 없는 id에 붙인 값이다. models.dev 현재값은 `-1017` 스냅숏의 32.6뿐이다.
- 대체 순서: 그 경로의 값 → 같은 계열의 최빈값(conflict 표시) → 출처 있는 사전값 → '비교 불가'.

**가격 계층:** 기준 요청 비용으로 정한다.
- 기준 요청 비용 = 단가 4종 × 입력 4k, 출력 1k, 캐시 읽기 160k, 캐시 쓰기 1k.
- 경계: 빠르고 싼 < $0.01, 범용 $0.01~$0.06, 고성능 ≥ $0.06.
- 이 사용자가 쓰는 12개 계열 중 11개가 실제 요청당 비용과 같은 계층에 들었다. GLM Flash는 그 경로의 작업 형태(요청당 캐시되지 않은 입력 26k) 때문에 예외였다.
- 빠르고 싼 계층은 30일 요청의 30.9%였다.

**`priors.yml` 범위:** 이름 해석 어휘, 등급 순서, 계층 경계와 기준 토큰 구성, 출처와 만료일이 있는 alias, (선택) 출처 있는 외부 품질 값. `int` 보정과 tps 사전값은 두지 않는다.

**남은 위험**
- 21%의 행은 class를 정하지 못해 이름만으로 묶인다.
- 어휘 목록은 새 접미사가 나올 때마다 손봐야 한다.
- 실행 중 `int` 커버리지는 시뮬레이션값(사용 가능한 100개 중 19 → 38 → 49개)뿐이다.

## 남은 확인

| 항목 | 이유 | 방법 |
|---|---|---|
| Orca 채팅의 `elicitation.form` 지원 | 미지원이면 Orca 채팅에서는 승인할 수 없다 | Orca에서 omp 채팅을 열고 스파이크 플러그인의 승인 도구를 호출한다(실제 모델 호출 1~2회) |
| `ctx.modelRegistry`의 실제 `int` 커버리지 | 시뮬레이션값만 있다 | v0.1 탐지 코드에서 측정 |
| eval 자식의 진행 중 비용 이벤트, `ctx.abort()`의 자식 중단 범위 | 예산 누계와 `onExceed: "stop"`의 정확도 | 하네스에 시나리오 추가 |
| `omp stats --summary` 증분 갱신 시간 | 신선도 대책의 비용 | 실제 DB 사본을 둔 프로필에서 측정 |
| `/agents` 허브의 플러그인 역할 에이전트 표시 | Q3의 일부 | TUI에서 확인 |
| 카탈로그 모델로 처음 라우팅할 때의 기능 확인 프로브 | 시험 사용 비용 | 실제 모델 경로에서 확인 |

## 재현

[spikes/p0/README.md](../spikes/p0/README.md)를 따른다. omp를 올린 뒤 같은 시나리오를 다시 돌리고, 결과가 바뀌면 이 문서와 계획서를 고친다.
