# OMP Storm

**Adaptive Multi-Agent Orchestration**
One command. Intelligent agents. Any runtime.

[omp](https://github.com/can1357/oh-my-pi)에서 `/storm` 하나로 프로젝트의 멀티에이전트 팀을 구성하고 실행하고 관리하는 플러그인입니다. 환경을 탐지해 역할별 모델·effort·병렬도를 근거와 함께 추천하고, 사용자가 승인한 구성만 적용합니다. 실행은 omp 기본 기능(`task`, `workflowz`, `orchestrate`)이 맡습니다.

```text
/storm                               # 최초: 탐지 → 추천 → 인터뷰 → 승인
/storm 로그인 기능 구현해줘
/storm 이번엔 비용보다 성능을 우선해줘
```

현재 계획 단계이며 코드는 아직 없습니다.

- 계획서: [docs/plan.md](docs/plan.md)
- 다음 단계: P0 스파이크 ([계획서 14장](docs/plan.md#14-구현-단계))
