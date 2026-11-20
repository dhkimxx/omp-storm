# P0 스파이크 하네스

omp를 실제 모델 대신 가짜 LLM 서버에 연결해 확장 API 동작을 실측한다. 유료 호출이 없고, omp가 모델에 보내는 요청(메시지, 도구, 모델 ID)을 그대로 기록한다. 결과는 [docs/p0-results.md](../../docs/p0-results.md)에 있다.

| 파일 | 역할 |
|---|---|
| `fake-llm.ts` | OpenAI 호환 `chat/completions` 서버. 지시문(`SPIKE-TASK`, `SPIKE-EVAL`, `SPIKE-APPROVE`, `SPIKE-SLOW`)에 정해진 응답을 하고, 요청마다 키워드 notice·역할 표식·도구 목록을 JSONL로 남긴다 |
| `plugin/` | 스파이크 플러그인: 스폰 훅 정책, `sendUserMessage` 프로브, 도구 안 승인 UI 프로브, 역할 에이전트 `storm-implementer`·`storm-reviewer` |
| `run.ts` | 시나리오 드라이버. 시나리오마다 새 omp 프로세스(RPC·ACP·print·TUI)를 띄운다 |

## 실행

bun 1.4 이상과 `expect`(TUI 시나리오)가 필요하다. omp는 `--profile storm-p0`로 격리 프로필에서 돈다. 이 프로필에는 가짜 Provider만 있다.

```bash
cd spikes/p0
FAKE_LLM_LOG=/tmp/storm-p0/llm.jsonl bun fake-llm.ts &   # 127.0.0.1:18555
bun run.ts setup                                          # ~/.omp/profiles/storm-p0/agent/models.yml 작성
bun run.ts all                                            # 또는 시나리오 이름 나열
bun run.ts cleanup                                        # 프로필 삭제
```

결과는 시나리오마다 JSON 한 줄로 출력되고 `/tmp/storm-p0/results.jsonl`에도 쌓인다. 환경 변수: `OMP_BIN`, `SPIKE_PROFILE`, `SPIKE_WORK`, `FAKE_LLM_PORT`.

| 시나리오 | 확인하는 것 |
|---|---|
| `q1-typed`, `q1-idle`, `q1-auto`, `q1-followUp`, `q1-steer`, `q1-deferred` | `sendUserMessage` 경로별 매직 키워드 notice 주입 |
| `q2-task`, `q2-eval`, `q2-override-observe`, `q2-override-route`, `q2-builtin` | 스폰 훅의 모델 교체·차단, `task.agentModelOverrides`와의 우선순위, 기본 에이전트 이벤트 |
| `q3-link`, `q3-shadow` | `plugin link`로 설치한 플러그인의 에이전트 발견, 프로젝트 `.omp/agents`의 같은 이름 에이전트 우선 여부 |
| `q4-rpc`, `q4-rpc-noui`, `q4-print`, `q4-acp-form`, `q4-acp-noform`, `q4-tui` | 도구 안 `ctx.ui.select`·`confirm` 동작 |
| `q5-maxcost` | `--max-cost`가 서브에이전트 비용을 합산하는지(가짜 `priced` 모델은 요청당 $0.11) |

## 주의

- `setup`은 격리 프로필의 `config.yml`에 `setupVersion: 3`을 쓴다. 이 값이 없으면 새 프로필의 TUI가 첫 실행 마법사(로그인 Provider 선택)를 띄우는데, 거기서 Enter를 누르면 실제 OAuth 로그인 흐름이 시작된다. `q4-tui`는 마법사가 보이면 Esc만 보낸다. 키 입력 순서를 바꿀 때 이 점을 유지한다.
- TUI는 시작할 때 터미널 질의(DA1, OSC 11)에 응답이 와야 화면을 그린다. `q4-tui`의 expect 스크립트가 이 응답을 보낸다.
