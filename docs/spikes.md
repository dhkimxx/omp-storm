# OMP Storm 스파이크 결과

- omp의 실제 동작을 가짜 LLM으로 실측한 결과와, 거기서 나온 결정을 모은 문서다. 유료 모델 호출은 없다.
- 끝난 실측은 그때의 omp 버전 기준이다. omp를 올리면 [재현](#재현)대로 다시 돌린다.

| 스파이크 | 일시 | 확인한 것 | 하네스 |
|---|---|---|---|
| P0 (Q1~Q9) | 2026-11-20 | 확장 API로 인계, 스폰 강제, 승인, 예산, 저장, 사용 이력 읽기가 되는가 | 지웠다. `scripts/e2e`가 같은 경로를 확인한다 |
| [B0](#b0-하위-기록-삭제) | 2026-11-21 | 끝난 하위 에이전트의 기록을 지워도 omp가 견디는가 | [spikes/b0](../spikes/b0/README.md) |
| [M0](#m0-세션-모드vibegoalloop) | 2026-11-21 | omp 세션 모드(vibe·goal·loop)를 확장에서 몰 수 있는가 | [spikes/m0](../spikes/m0/README.md) |

## P0 환경과 방법

- **일시:** 2026-11-20
- **환경:** macOS arm64, omp 19.0.1(바이너리). 소스 근거는 `@oh-my-pi/*` 19.0.0, 하네스 실행은 bun 1.4.4.
- **방법:**
  - **Q1~Q5 실행 경로:** `spikes/p0` 하네스로 실측했다. 하네스는 E2E가 대신하게 되어 지웠다(git 기록에 있다).
    - omp를 격리 프로필(`--profile storm-p0`)에서 가짜 OpenAI 호환 서버에 연결하고, 시나리오마다 RPC·ACP·print·TUI 모드로 새 프로세스를 띄웠다.
    - 유료 모델 호출은 0회다.
    - 아래 값은 하네스를 고친 뒤 전체 시나리오 20개를 한 번에 다시 돌린 결과다.
  - **Q5~Q9 일부:** omp 소스와 이 Mac의 사용자 데이터(`stats.db`, 카탈로그 캐시)를 읽기 전용으로 분석했다.

## P0 요약

| # | 질문 | 결론 | [설계](design.md) |
|---|---|---|---|
| 1 | `sendUserMessage`로 키워드 계약을 넘길 수 있나 | `deliverAs` 없이 보낼 때만 notice가 붙는다. `followUp`·`steer`는 전달되지만 notice가 없다 | 6장. 0.10부터 키워드를 쓰지 않는다 |
| 2 | 스폰 훅으로 모델 강제·차단이 되나 | task·eval 모두 된다. `agentModelOverrides`보다 우선하고, 기본 에이전트도 훅을 거친다 | 2장, 6장 |
| 3 | 플러그인 `agents/`의 역할 에이전트 | 발견과 이름 스폰 모두 된다. 단 프로젝트·사용자 정의가 덮어쓴다 | 2장, 8장 |
| 4 | 도구 안 승인 UI | TUI·RPC·폼 지원 ACP에서 동작한다. 나머지는 자동 미승인이고, `hasUI`로는 구분할 수 없다 | 2장, 5장 |
| 5 | 예산 상한 | omp 세션 상한이 유일한 확실한 상한(자식까지 막음)이다. 확장용 공개 API는 없다 | 2장 |
| 6 | 승인 기록 형식 | repo-id는 git common dir 해시, 승인은 설정 해시별, 해시는 JCS 정규화 SHA-256 | 5장 |
| 7 | omp가 `.omp/storm/`을 읽나 | 읽지 않는다 | 7장 |
| 8 | 30~90일 이력 경로 | `stats.db` 읽기 전용 직접 조회. 신선도와 gc 삭제에 대비해야 한다 | 3장, 4장 |
| 9 | 카탈로그 공백·계열 키 | 계열 키 `class/등급@revision`, 가격 계층 $0.01/$0.06, `int`·`tps` 대체 순서 | 4장 |

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
- (0.10에서 대체됨: 실행 계약은 키워드 없이 보낸다. 계약 전체가 XML 구획 하나라 omp의 키워드 매처가 건너뛴다. `/storm`에서 바로 시작하고, 도구가 예약한 실행만 `agent_end` 뒤에 시작한다.)

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
  - M0에서 직접 관찰했다. 훅은 스폰을 부른 서브에이전트 쪽 확장 인스턴스에서 불린다(메인 쪽이 아니다).
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
- 승인할 수 없는 환경에서는 제안을 보관하고, 승인할 수 있는 곳(TUI 등)을 안내한다. (0.10에서 대체됨: 보관하지 않는다. 답이 없으면 취소다.)

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

**결정:** 세 겹(스폰 차단 + 자체 누계 경고 + `--max-cost` 권고)으로 지킨다([design.md](design.md) 2장).
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

**결정:** [design.md](design.md) 5장. P0 때 정한 승인 기록 예(0.10부터는 판정에 쓰는 필드만 쓴다. 예전 기록도 그대로 읽는다):

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

**결정:** `.omp/storm/` 구조를 확정한다([design.md](design.md) 7장). 역할 에이전트는 플러그인 `agents/`에만 둔다. `.omp/storm/agents/`는 탐색되지 않는다.

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

**결정:** [design.md](design.md) 4장.
- 경로는 `getStatsDbPath()`로 얻고 읽기 전용으로 연다. `immutable=1`은 쓰지 않는다.
- 필수 컬럼을 검사한다. 분위수는 처음에 윈도우 함수로 구하기로 했으나, 구현은 단순 조회 뒤 TS에서 계산한다(`src/history/stats.ts`).
- 결과에 데이터 기준 시각을 표시하고, 필요하면 `omp stats --summary`로 갱신한다.
- 일 단위 집계를 따로 보관한다. (0.10에서 대체됨: 보관하지 않는다. 분석 창이 gc 보존 기간 안이라 보관본이 쓰인 적이 없다.)

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
- 대체 순서: 그 경로의 값 → 같은 계열의 최빈값(conflict 표시) → 출처 있는 사전값 → '비교 불가'. (0.10에서 대체됨: 계열마다 경로 값들의 중앙값 하나를 쓴다. `src/lineage/metrics.ts`)

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

## B0. 하위 기록 삭제

v0.9 청소부가 열린 부모 세션 안의 끝난 하위 에이전트 기록을 지워도 되는지 확인했다(2026-11-21, omp 19.0.1, RPC 모드, 플러그인 없이 [spikes/b0](../spikes/b0/README.md)). 깨끗한 실행 두 번이 같은 결과를 냈다.

| 상황 | 결과 |
|---|---|
| 메모리에 살아 있는(idle) 하위 에이전트의 기록을 지움 | 오류는 없다. omp가 기록 파일을 쓰기용으로 열어 두고 있어, 그 뒤 후속 지시의 기록은 지워진 파일로 가서 사라진다. 재시작 전까지 목록에는 살아 있는 것으로 남는다 |
| 디스크로 내린(parked) 하위 에이전트의 기록을 지움 | 후속 지시가 `Failed: <id> is not running. ENOENT…`로 깔끔하게 실패한다. 다음 요청과 종료는 정상이다. 지우지 않은 형제 에이전트는 정상으로 되살아난다 |
| 부모 세션 재개(`--resume`) | 오류가 없다. 지운 에이전트는 목록과 `history://`에서 빠지고, 남긴 에이전트는 되살아난다 |
| 결과(`<id>.md`)만 남기고 기록·부속 파일·하위 폴더를 지움 | 재개 뒤에도 `agent://<id>`가 결과를 돌려준다. 후속 지시는 위와 같이 실패한다 |
| 같은 이름으로 다시 띄움 | 실행 중인 세션에서는 늘 접미사(`-2`)가 붙는다. 재개 뒤에는 다 지운 이름이 그대로 다시 발급되고 새 기록이 옛 경로에 쌓인다. 결과를 남긴 이름은 접미사가 붙는다 |
| `stats.db` | 지운 기록의 행은 삭제와 통계 동기화 뒤에도 남는다 |
| 잠금 | 기록 파일 옆에 잠금 파일은 없다. 살아 있는 하위 에이전트만 기록 파일을 열어 둔다 |

**결정:** 청소부는 내린 에이전트(이전 omp 프로세스의 것이거나, omp의 내림 시간 `task.agentIdleTtlMs`보다 오래 쉰 것)만 정리한다. 결과(`.md`)는 남기고 기록, 부속 파일, 하위 폴더의 기록만 지운다. 정리한 에이전트로 가는 후속 지시는 Storm이 막는다. `stats.db`는 건드리지 않는다.

## M0. 세션 모드(vibe·goal·loop)

0.10 실행 모드를 설계하기 전에, 확장이 omp의 세션 모드를 몰 수 있는지 확인했다(2026-11-21, omp 19.0.1, [spikes/m0](../spikes/m0/README.md), 시나리오 16개). TUI는 pty로 자동화했다. 소스 경로는 `@oh-my-pi/pi-coding-agent/src/` 기준이다.

**결론:** 세 모드 모두 확장에서 켜고 끌 수 있지만 TUI에서만 된다. 0.9의 실행 종료 규칙(메인 세션이 정착하면 끝)에 맞는 것은 vibe뿐이다. goal과 loop는 턴 경계마다 실행이 끝난 것처럼 보인다.

### 모드별

| | vibe | goal | loop |
|---|---|---|---|
| 컨텍스트 | 숨은 `<vibe-mode>` 사용자 메시지(1,795자)가 프롬프트마다 붙는다. 시스템 프롬프트에는 없다 | `<goal_context>`(약 820자)가 프롬프트와 이어 가기마다 붙고, 숨은 이어 가기 메시지(1,597자)가 더해진다. 이어 가기 한 번에 약 2.4천 자가 쌓인다 | 붙는 것이 없다. 반복 프롬프트는 일반 사용자 메시지다 |
| 도구 | 16개가 7개로 줄어든다: `read`, `todo`, `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`. 확장 도구와 `write`가 빠져 `xd://<도구>` 경로도 닿지 않는다 | `goal` 도구가 더해진다. 일시 정지나 종료 때 빠진다 | 그대로 |
| 이어 가기 | 워커 턴은 비동기 작업이고, 결과는 `Background job … completed` 메시지로 온다 | 턴이 끝나고 800ms 뒤, 유휴이고 입력창이 비었고 plan·loop가 꺼져 있으면 숨은 이어 가기가 간다 | `agent_end` 800ms 뒤 프롬프트를 다시 보낸다 |
| 끝 | 도는 워커 없이 감독이 멈추면 끝난다. 모드를 끄면 턴을 중단하고 워커를 죽인다 | `goal({op:"complete"})`, 일시 정지, 버림, 사용자 중단(일시 정지), 예산 소진, 조용한 멈춤(아래) | 횟수·시간 한도, 조건, 끄기. Provider 오류나 Esc는 일시 정지 |
| `--continue` 뒤 | 7개 도구와 함께 켜진 채 복원된다 | **일시 정지**로 돌아오고 토큰 누계는 남는다 | 사라진다(메모리에만 있음) |
| omp 설정 | 없음 | `goal.enabled`(기본 켬), `goal.continuationModes`(기본 `["interactive"]`) | `loop.mode`(prompt·compact·reset, 기본 prompt), `loop.conditionTimeoutMs` |
| 호스트 | TUI | TUI. RPC는 호스트 명령 `{type:"goal",op}`로만 | TUI |

- 세 슬래시 명령은 TUI 전용이다(`slash-commands/builtin-modes.ts`). RPC와 ACP에서는 `/vibe`, `/loop 2 hello`, `/goal set …`이 일반 텍스트로 모델에 갔다.
- ACP는 `default`와 `plan` 모드만 알리고, print에는 모드가 없다.

### vibe 워커

- **정체:** 턴 사이에도 살아 있는 프로세스 안 서브에이전트 세션이다(`vibe/runtime.ts`). 워커의 `session_start`는 host=print, hasUI=false로 기록됐다.
- **모델:** `fast`는 번들 `sonic` 에이전트, `good`은 번들 `task` 에이전트(세션 모델)다.
- **확장이 모델을 고를 수 있나:** 스폰마다는 못 고른다. `task.agentModelOverrides`의 `task`·`sonic`으로 바뀌지만, 이 설정은 일반 `task`·`sonic` 서브에이전트에도 똑같이 걸린다.
- **`before_subagent_spawn`은 `vibe_spawn`에 불리지 않는다.** 훅을 내는 곳은 `task/structured-subagent.ts` 하나이고, vibe는 하위 프로세스 실행을 직접 부른다.
- **워커 안에도 확장이 로드된다.** `ctx.agent`는 일반 서브에이전트와 같은 모양(`kind: "sub"`, `name: "task"|"sonic"`, `depth: 1`)이다. 워커와 감독을 잇는 것은 감독의 `tool_call vibe_spawn`에 담긴 `name` 인자뿐이다.
- **`good` 워커는 Storm 역할 에이전트를 스폰할 수 있다.** 이때 스폰 훅은 감독이 아니라 워커 쪽 확장 인스턴스에서 불린다. 그 자식은 깊이 2라 `task` 도구가 없다(`task.maxRecursionDepth` 2).
- **`fast` 워커는 스폰할 수 없다.** `task` 도구는 있지만 `Cannot spawn 'task'. Allowed: none`이 돌아온다.
- **플러그인 로드 방식:** 설치(link)하지 않고 `-e <디렉터리>`로 로드하면 워커가 `Unknown agent "storm-implementer"`를 받는다.
- **감독의 `tool_call` 처리기는 vibe에서도 불린다.** `vibe_spawn`을 막을 수 있고, 모델은 사유를 도구 결과로 받는다.

### goal의 이벤트와 멈춤

- **턴 경계:** 이어 가기 사이의 `agent_end`는 모두 종료형이다(`willContinue`도 `awaitingAsyncWork`도 없다). 약 0.8초 뒤 `input` 이벤트 없이 `agent_start`가 온다. 서브에이전트를 기다리는 턴만 `willContinue=true`, `awaitingAsyncWork=true`다.
- **이벤트는 모두 `goal_updated`로 온다.**

  | 일어난 일 | `goal_updated` | `mode_changed` |
  |---|---|---|
  | 완료 | `status: "complete"` | 턴이 끝난 뒤 goal → inactive |
  | 일시 정지 | `status: "paused"`, `enabled: false` | goal → paused |
  | 버림 | `status: "dropped"` | goal → inactive |
  | 예산 소진 | `status: "budget-limited"` | **없음.** `getState()`는 여전히 `active`이고 이어 가기만 멈춘다 |

- **토큰 누계:** `goal_updated`의 `tokensUsed`, `tokenBudget`, `timeUsedSeconds`로 읽는다. 도구가 끝날 때와 턴 끝에 온다. `getState().goal`에는 목표와 예산만 있다.
- **메인 세션만 센다**(입력 + 출력 + 캐시 쓰기). 메인 요청 9건에 990이었고, 그 사이 돈 자식은 빠졌다.
- **`task` 서브에이전트는 goal 안에서 그대로 돈다.**
- **조용한 멈춤:** 이어 가기 턴이 도구 호출 없이 끝나거나, 직전 이어 가기와 도구 활동이 같으면 이어 가기가 멈춘다(`goals/state.ts`). goal은 `active`로 남고, 이벤트가 없고, 사용자가 새 프롬프트를 넣어야 다시 돈다.
- **RPC:** `goal.continuationModes`에 rpc를 넣으면 이어 가기가 돌고, 호스트는 `session_settled`를 끝에 한 번만 본다. 이때 `goal create`는 프롬프트 없이 첫 턴을 스스로 시작한다.

### loop의 모양

- **한도:** `{kind: "iterations", iterations}` 또는 `{kind: "duration", durationMs}`.
- **조건:** `{command, until}`. 종료 코드 0·1이 답이고, 그 밖의 코드나 시간 초과는 오류로 loop를 끝낸다.
- **반복 사이:** 종료형 `agent_end`, 800ms, 조건 명령, `loop.mode`에 따른 압축이나 새 세션, 다시 보내기 순이다. 반복은 `input` 이벤트를 내지 않는다.
- **횟수는 반복 수다.** `iterations: 2`는 3턴(첫 프롬프트 + 2)을 돌았다.
- **끝:** `mode_changed` loop → inactive.
- **반복 프롬프트:** `set()`의 `prompt`로 준 텍스트다. `pi.sendUserMessage`로 보낸 프롬프트는 반복 본문으로 잡히지 않는다(입력창 제출만 잡힌다). `prompt` 없이 켠 loop는 한 턴만 돌고 기다렸다.

### 모드 조합과 `set()` 호출 위치

| 요청 ↓ / 켜져 있는 것 → | vibe | goal(켜짐·일시 정지) | plan | loop |
|---|---|---|---|---|
| vibe 켜기 | 됨(변화 없음) | `conflict` | `conflict` | 됨 |
| goal 켜기 | `conflict` | 같은 목표면 됨, 다르면 `invalid_request` | `conflict` | 됨 |
| loop 켜기 | 됨 | 됨 | 됨 | 한도를 바꾸면 `invalid_request`, 프롬프트만 바꾸면 됨 |

- **goal + loop:** loop가 몬다. loop가 켜진 동안 goal 이어 가기는 없고, 한도 뒤에는 goal이 켜진 채 쉰다.
- **vibe + loop:** 된다. `loop.mode: reset`일 때만 안 된다.
- **`set()`을 부를 수 있는 곳:**

  | 위치 | 결과 |
  |---|---|
  | 명령 처리기 | 됨 |
  | 종료형 `agent_end` 처리기 | 바로 됨 |
  | 도구의 `execute` | `busy`(턴이나 압축이 도는 중) |
  | `session_start` | `busy`(저장된 모드를 복원하는 중) |

- **`set()`은 아무것도 시작하지 않는다.** 어떤 모드 전환도 프롬프트를 보내지 않으므로 첫 프롬프트는 따로 보내야 한다.
- **`extensionHandlers.modeControl`**(기본 켬)을 끄면 모든 `set()`이 `disabled`를 돌려준다. `getState()`는 되고, 사용자 화면에는 아무것도 뜨지 않는다.

### 호스트 지원

- `ctx.sessionModes`는 TUI에만 있다. RPC, ACP, print, 모든 서브에이전트 안에서는 `undefined`다.
- 모드 없이 이어 가는 길은 `session_stop` 이어 가기다. RPC에서 돌았고, 실행이 한 번의 실행으로 남아 0.9의 종료 규칙이 그대로 맞는다.
- `session_stop`의 한계:
  - 연속 이어 가기는 최대 8번이다(멈춤 9번 중 8번 이어 감).
  - 서브에이전트에는 불리지 않는다.
  - 비동기 작업이 남아 있으면 묻지 않는다.
- 이 길로 잃는 것: vibe 전부, `goal` 도구와 완료 신호·예산 누계·상태줄·저장, loop의 조건 명령과 compact·reset. 완료 신호와 멈춤 감시는 Storm이 직접 만들어야 한다.

### 설계 제약

1. `ctx.sessionModes`가 있는지 확인하고, `disabled`를 처리하고, RPC·ACP·print에서는 모드 없는 길로 간다.
2. `set()`은 명령 처리기나 종료형 `agent_end`에서만 부르고, 첫 프롬프트는 따로 보낸다.
3. 실행 종료가 모드를 알아야 한다. 종료형 `agent_end`마다 끝내는 0.9 규칙으로는 goal·loop 실행이 첫 턴 뒤에 끝난다.
   - goal: `goal_updated`의 완료·버림에서 끝내고, 일시 정지와 예산 소진의 뜻을 정해야 한다.
   - loop: `mode_changed` loop → inactive에서 끝낸다.
4. goal에는 멈춤 감시가 필요하다(종료형 `agent_end` 뒤 goal은 켜져 있는데 새 턴이 시작되지 않는 경우).
5. omp vibe는 Storm의 계획·역할 강제를 그대로 실을 수 없다. 감독에게 `task`와 `storm` 도구가 없고, 스폰 훅이 없고, 역할 대신 범용 에이전트 둘뿐이며, 모델은 전역 설정으로만 바뀐다.
6. 모드 문구는 컨텍스트를 쓴다. vibe는 프롬프트마다 약 1.8천 자, goal은 이어 가기마다 약 2.4천 자다.
7. `session_start`에서는 `mode_changed`로 상태를 맞춘다. 복원 뒤에 오며, goal은 일시 정지, loop는 없음, vibe는 켜짐이다.
8. Storm 예산은 goal 예산에 기댈 수 없다. goal 예산은 서브에이전트 지출을 세지 않는다.
9. 워커가 `storm-*` 에이전트를 보려면 Storm이 플러그인으로 설치돼 있어야 한다.

**결정 (0.10 설계):** Storm 실행은 늘 승인된 팀과 감독 규칙으로 돌고, 모드는 실행이 언제 끝나는지만 정한다.

| Storm 모드 | 방법 | 실행이 끝나는 때 |
|---|---|---|
| vibe(기본) | Storm 자체의 감독 실행이다. omp vibe 모드에는 들어가지 않는다(제약 5) | 메인 세션이 정착할 때 |
| goal | omp goal 모드에 들어간다 | omp가 완료나 버림을 알릴 때. 일시 정지, 예산 소진, 멈춤은 중단으로 끝낸다 |
| loop | omp loop 모드에 들어간다. 반복 프롬프트는 `set()`의 `prompt`로 준다 | omp loop가 꺼지거나 일시 정지될 때 |

- omp vibe가 켜져 있으면 Storm 팀이 그 안에서 돌 수 없으므로, 끄고 시작할지 묻는다.
- `ctx.sessionModes`가 없는 호스트에서 goal·loop를 요청하면 기본 모드로 시작할지 묻는다.
- 사용자의 `loop.mode`가 `reset`이면 loop 실행을 거절한다. 반복마다 새 세션이 되어 실행이 이어지지 않는다.
- `session_stop` 이어 가기는 쓰지 않는다. 8번 한도가 있고 완료 신호를 따로 만들어야 한다.

## 남은 확인

확인하지 못한 항목은 [next.md](next.md#확인하지-못한-것)에 모았다.

## 재현

- P0: 하네스는 지웠다. 같은 경로는 `npm run e2e`와 `npm run e2e:tui`가 확인한다.
- B0: [spikes/b0/README.md](../spikes/b0/README.md)
- M0: [spikes/m0/README.md](../spikes/m0/README.md)

omp를 올린 뒤 같은 시나리오를 다시 돌리고, 결과가 바뀌면 이 문서와 설계 문서를 고친다.
