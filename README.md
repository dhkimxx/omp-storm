# OMP Storm

**Adaptive Multi-Agent Orchestration**
One command. Intelligent agents. Any runtime.

[omp](https://github.com/can1357/oh-my-pi)에서 `/storm` 하나로 프로젝트의 멀티에이전트 팀을 구성하고 관리하는 플러그인입니다. 사용 기록과 omp 카탈로그로 역할별 모델을 추천하고, 사용자가 승인한 구성만 서브에이전트가 스폰될 때 강제합니다. 실행은 omp 기본 기능(`task`, eval `agent()`)이 맡습니다.

## v0.1

| 명령 | 하는 일 |
|---|---|
| `/storm` | 설정이 없으면 설정 인터뷰, 승인되지 않은 설정이 있으면 리뷰, 승인됐으면 현황 |
| `/storm setup` | 탐지 → 사용 기록 분석 → 역할별 추천 → 인터뷰 → 승인 → `.omp/storm/config.json` 저장 |
| `/storm status` | 설정·승인 상태, 역할별 모델, 가림 정의, 쿼터, 사용 기록 기준 시각 |
| `/storm review` | 승인되지 않은 설정(직접 편집, 팀원 커밋)이나 가림 정의를 보여 주고 승인 |
| `/storm rollback` | 이전에 승인한 설정으로 되돌리기 |

**역할 에이전트:** `storm-explorer`(읽기 전용 탐색), `storm-implementer`(구현), `storm-reviewer`(읽기 전용 리뷰)를 제공합니다. task나 eval `agent()`로 이 역할을 스폰하면 Storm이 승인된 모델과 effort로 바꿉니다. 다음 경우에는 스폰을 막고 이유를 남깁니다.
- 설정이 없을 때
- 설정이 승인되지 않았을 때
- 프로젝트·사용자 `agents/`의 같은 이름 정의가 승인 없이 역할을 가릴 때

**분석:** 최근 30일 omp 사용 기록에서 다음을 계산합니다.
- 모델 계열별(여러 Provider 합산) 선호와 가격 계층별 선호
- 실측 속도(omp tok/s, 생성 tok/s, TTFT)
- 쓰다 멈춘 모델과 그 이유
- 새 버전, 더 좋거나 더 싼 대안

지표가 없으면 '비교 불가'로 표시하고 추측하지 않습니다.

**승인:** 승인 기록은 저장소 밖 `<omp 에이전트 디렉터리>/storm/approvals/`에 설정 해시별로 남습니다. 그래서 팀원이 커밋한 설정도 각자 승인해야 하고, 같은 저장소의 worktree끼리는 승인을 공유합니다. 승인 창을 띄울 수 없는 모드(print, `--no-ui`, 폼 미지원 ACP)에서는 아무것도 바꾸지 않습니다.

**omp 설정:** Storm은 omp 설정을 바꾸지 않습니다. 플러그인을 지우거나 `.omp/storm/`을 지우면 원래대로 돌아갑니다. 저장소 밖에 쓰는 것은 `<omp 에이전트 디렉터리>/storm/` 아래의 승인 기록과 사용 기록 일 단위 보관본(`omp gc`가 오래된 기록을 지워도 분석이 이어지도록)뿐입니다. 보관본은 `/storm`을 취소해도 남습니다.

**아직 없는 것(v0.2 이후):** `/storm <자연어>` 작업 실행·관리, 시험 사용, 실행 단위 예산 강제(지금은 `omp --max-cost` 사용을 권고만 합니다), Orca·Herdr 런타임.

## 설치

```bash
omp plugin install github:dhkimxx/omp-storm   # 저장소 접근 권한 필요(비공개)
omp plugin link /path/to/omp-storm            # 로컬 체크아웃으로 개발할 때
```

## 개발

```bash
npm ci --ignore-scripts && npm rebuild bun --ignore-scripts=false
npm run verify   # tsc + bun test
npm run e2e      # 가짜 LLM 서버로 실제 omp에서 확인(유료 호출 없음, omp 필요)
```

- 계획서: [docs/plan.md](docs/plan.md)
- P0 결과: [docs/p0-results.md](docs/p0-results.md), 하네스: [spikes/p0](spikes/p0/README.md)
