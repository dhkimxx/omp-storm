# L0 lane view: stills

Text stills, no colour codes, 100 columns, `maxRows` 10, motion on, unicode. Produced by `play.ts --still MS` (the player and this
file use the same frames). Motion and colour are the other half of the design: each caption says what the colour does at that
moment, because a still cannot show it.

Regenerate one with `node_modules/.bin/bun spikes/l0/play.ts --variant box --width 100 --still 12000`.

## Variant `box`

### 워커 작업 중 (workers running), t = 12.0 s

Phase `workers`. In colour the trunk breathes slowly and light flows from each branch point down the running lanes, faster on a busy lane. The idle lane (문서-초안) is thin and still, a finished-but-not-accepted lane (탐색-구조, 제출) has stopped flowing. The job lane fills its squares in turn.

```
디렉터 0/6 $0.37     ◉┯━━━━━━━━━━━                                                 워커 작업 중
탐색-구조       탐색  ├┈┈───────╤═                                                 제출
구현-API        구현  ├┈┈───────┼▸                                                 작업 중
테스트-작성     리뷰  ├┈┈┈┈┈┈┈┈┈┴▸                                                 작업 중
빌드-잡         신속  ├┈┈■─■─■─■─▸                                                 작업 중
설계-검토       설계  ├┈┈────────▸                                                 작업 중
문서-초안       신속  ╰┈┈────╌╌╌╌╴                                                 유휴
```

### 레인이 트렁크에 합류 (a lane joining the trunk), t = 24.4 s

탐색-구조 was accepted 0.4 s ago: it turns up into the trunk and leaves a node there (box: the corner under the trunk node; braille: the S-curve up). In colour one flash starts at that node and spreads along the trunk; after it the lane is still and dimmed. The other two lanes are under review.

```
디렉터 2/6 $0.75     ◉┯━━━━━━━━━━━━━━■━━━━━━━●                                     검증 중
탐색-구조       탐색  ├┈┈───────╤════╪═══════╛                                     승인
구현-API        구현  ├┈┈───────┼────┼──═════◆                                     검토 중
테스트-작성     리뷰  ├┈┈┈┈┈┈┈┈┈┴────┼─══════◆                                     검토 중
빌드-잡         신속  ├┈┈■─■─■─■─■─■─╯                                             승인
설계-검토       설계  ├┈┈──────────✕                                               막힘
문서-초안       신속  ╰┈┈────╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╴                                     유휴
```

### 검증 중 (review in progress), t = 22.0 s

Phase `verifying`. Three lanes are reviewed: double line and a diamond at the head. In colour a success-coloured scan travels back and forth on the trunk and on those lanes in the same rhythm.

```
디렉터 1/6 $0.67     ◉┯━━━━━━━━━━━━━━■━━━━━◆                                       검증 중
탐색-구조       탐색  ├┈┈───────╤════╪═════◆                                       검토 중
구현-API        구현  ├┈┈───────┼────┼──═══◆                                       검토 중
테스트-작성     리뷰  ├┈┈┈┈┈┈┈┈┈┴────┼─════◆                                       검토 중
빌드-잡         신속  ├┈┈■─■─■─■─■─■─╯                                             승인
설계-검토       설계  ├┈┈──────────✕                                               막힘
문서-초안       신속  ╰┈┈────╌╌╌╌╌╌╌╌╌╌╌╌╌╌╴                                       유휴
```

### 응답 대기 (waiting for the user), t = 31.0 s

Phase `waiting-user`. Nothing moves. The trunk head is a solid warning-coloured block. 문서-초안 was just excluded by the user (dotted line, slashed circle); 구현-API is unmet and shown as a hollow circle.

```
디렉터 3/5 $0.95     ◉┯━━━━━━━━━━━━━━■━━━━━━━●━●━━━━█                              응답 대기
탐색-구조       탐색  ├┈┈───────╤════╪═══════╛ │                                   승인
구현-API        구현  ├┈┈───────┼────┼──═══════╪○───╴                              미충족
테스트-작성     리뷰  ├┈┈┈┈┈┈┈┈┈┴────┼─════════╛                                   승인
빌드-잡         신속  ├┈┈■─■─■─■─■─■─╯                                             승인
설계-검토       설계  ├┈┈──────────✕                                               막힘
문서-초안       신속  ╰┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈⊘                               제외
```

### 종료 정리 중 (stopping), t = 57.0 s

Phase `stopping`. In colour the light fades from the left end of the trunk and the lanes go dark one by one; a still shows the settled shape only. Every lane here has already settled (accepted, blocked or excluded), so the round ticks and the nodes are what is left.

```
디렉터 4/5 $1.75     ◉┯━━━━━━━━━━━━━━■━━━━━━━●━●━━━━━━━━━◉2━━━━━━━━━━━━●━◉3━━━╸    종료 정리 중
탐색-구조       탐색  ├┈┈───────╤════╪═══════╛ │                       │           승인
구현-API        구현  ├┈┈───────┼────┼──═══════╪○─────────────────═════╛           승인
테스트-작성     리뷰  ├┈┈┈┈┈┈┈┈┈┴────┼─════════╛                                   승인
빌드-잡         신속  ├┈┈■─■─■─■─■─■─╯                                             승인
설계-검토       설계  ├┈┈──────────✕                                               막힘
문서-초안       신속  ╰┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈⊘                               제외
```

## Variant `braille`

### 워커 작업 중 (workers running), t = 12.0 s

Phase `workers`. In colour the trunk breathes slowly and light flows from each branch point down the running lanes, faster on a busy lane. The idle lane (문서-초안) is thin and still, a finished-but-not-accepted lane (탐색-구조, 제출) has stopped flowing. The job lane fills its squares in turn.

```
디렉터 R1/4            ⡷1⠶⠶⡶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠖ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐  30s 워커 작업 중
탐색-구조         탐색     ⠈⢏⣶⣾⡷⠶⠶⠶⠶⢶⣶⣾⡷⠶⠶⠶⡶⢶⣉⣉⡁                                    제출
구현-API          구현     ⠠⠘⢿⡷⠶⠶⢶⣶⣾⡷⠶⠶⠶⠶⠶⠶⢶⣶⣶⣶⠆                                    작업 중
테스트-작성       검토  ⠂    ⠈⢿⡤⠂ ⠂ ⠂ ⠂ ⠂ ⠂ ⠒⣶⣾⡇                                    작업 중
빌드-잡           빠른      ⠈ ⠘⣿⣏⣹⠒⠒⠒⣏⣹⠒⠒⠒⣏⣹⠒⠒⠒⠂                                    작업 중
설계-검토         설계       ⠁⠈⠈⢿⢶⢶⣶⣾⡷⠶⠶⠶⠶⢶⣶⣾⡷⠶⠆                                    작업 중
문서-초안         빠른    ⠂  ⠄  ⠘⠹⠷⠶⠶⠶⢶⠒⠒⠒⠒⠒⠒⠒⠒⠂                                    유휴
```

### 레인이 트렁크에 합류 (a lane joining the trunk), t = 24.4 s

탐색-구조 was accepted 0.4 s ago: it turns up into the trunk and leaves a node there (box: the corner under the trunk node; braille: the S-curve up). In colour one flash starts at that node and spreads along the trunk; after it the lane is still and dimmed. The other two lanes are under review.

```
디렉터 R1/4            ⡷1⠶⠶⡶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⣶⢾⡷⠶⠶⠶⠶⠶⠶⣿⣿⣿⠶⠶⠶⣶⠶⢾⡷⠂ ⠂ ⠂ ⠂ 30s 검증 중
탐색-구조         탐색     ⠈⢏⡶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⡶⠶⣉⣉⣉⣉⣉⣉⣉⣽⣉⣉⣉⣉⣉⣉⣉⣉⣉⣉⠶⠶⠶⢎⣉⡥⠊⠁             승인
구현-API          구현      ⠈⣿⣿⡷⠶⠶⠶⠶⢶⣶⣾⡷⠶⠶⠶⠶⡶⠶⠶⡷⠶⠶⠶⡾⢷⣶⣾⡷⠶⠶⠶⠶⢶⣉⣉⣉⣿⣿⣉⣉⣉⣉⣉◆            검토 중
테스트-작성       검토       ⠙⣿⣇⠂ ⠂ ⠂ ⠂ ⠂ ⠂ ⠒⡷⠶⠶⠶⢶⣾⣷⣾⡷⠶⠶⠶⠶⢶⣉⣉⣉⣉⣿⣿⣿⣉⣉⣉⣉⣉◆            검토 중
빌드-잡           빠른        ⠉⢿⣿⣿⠒⠒⠒⣿⣿⠒⠒⠒⣿⣿⠒⠒⠒⠒⠒⠋                                  승인
설계-검토         설계         ⠘⢿⡷⠶⠶⠶⠶⢶⣶⣾⡷⠶⠶⠶⠶⢶⣶⣾⡷⡱⢎                                막힘
문서-초안         빠른          ⠈⢹⣶⣾⡷⠶⠶⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒            유휴
```

### 검증 중 (review in progress), t = 22.0 s

Phase `verifying`. Three lanes are reviewed: double line and a diamond at the head. In colour a success-coloured scan travels back and forth on the trunk and on those lanes in the same rhythm.

```
디렉터 R1/4            ⡷1⠶⠶⡶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⣶⢾⡷⠶⠶⣿⣿⣿⠶⠶⠶⠶⠶⠶⠂ ⠂ ⠂ ⠂ ⠂ ⠂  30s 검증 중
탐색-구조         탐색     ⠈⢏⡶⠶⠶⠶⢶⣶⣾⡷⠶⠶⠶⠶⢶⣶⣾⡷⣉⣉⣉⣉⣉⣉⣉⣽⣉⣉⣉⣉⣉⣉⣉⣉⣉⣉⣉⣉⣉◆                 검토 중
구현-API          구현      ⠈⢿⣶⣶⣾⡷⠶⠶⠶⠶⢶⣶⣾⠶⠶⠶⡶⠶⠶⣶⣾⡷⠶⡾⠷⠶⢶⣶⣾⡷⠶⠶⠶⣉⣉⣉⣉⣉◆                 검토 중
테스트-작성       검토       ⠸⣿⣥⠂ ⠂ ⠂ ⠂ ⠂ ⠂ ⠒⣶⣾⡷⠶⢶⡾⠷⢶⣶⣾⡷⠶⠶⠶⣉⣉⣉⣉⣉⣉⣉◆                 검토 중
빌드-잡           빠른        ⠈⣿⣿⣿⠒⠒⠒⣿⣿⠒⠒⠒⣿⣿⠒⠒⠒⠒⠒⠋                                  승인
설계-검토         설계         ⠉⢿⣶⣾⡷⠶⠶⠶⠶⢶⣶⣾⡷⠶⠶⠶⠶⢶⣶⡱⢎                                막힘
문서-초안         빠른          ⠈⠹⠶⢶⣶⣾⡷⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒                 유휴
```

### 응답 대기 (waiting for the user), t = 31.0 s

Phase `waiting-user`. Nothing moves. The trunk head is a solid warning-coloured block. 문서-초안 was just excluded by the user (dotted line, slashed circle); 구현-API is unmet and shown as a hollow circle.

```
디렉터 R1/4            ⡷1⠶⡶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⠶⢶⢾⡷⠶⠶⠶⠶⠶⠶⠶⣶⠶⢾⡷⡶⢾⡷⠶⠶⠶⣿⣿⠖ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ ⠐ 45s 응답 대기
탐색-구조         탐색    ⠈⢿⡶⠶⠶⠶⠶⠶⠶⢶⠶⠶⣉⣉⣉⣩⣏⣉⣉⣉⣉⣉⣉⣉⣉⣉⡥⠊⠡⢍⠾⠁                          승인
구현-API          구현     ⠈⢿⠶⠶⠶⠶⠶⠶⠶⢶⠶⠶⠶⢶⠿⠶⠶⠶⠶⠶⠶⢎⣉⣉⣉⣉⣩⣏⣫⣉⣉⢎⡱⠒⠒⠒⠒⠂                   미충족
테스트-작성       검토      ⠈⢯⡄⠂ ⠂ ⠂ ⠂⠶⣶⠿⠶⠶⠶⠶⠶⠶⣉⣉⣉⣉⣉⣉⡵⠃                             승인
빌드-잡           빠른       ⠈⢿⣿⣿⠒⠒⠒⠒⠒⠚⠁                                            승인
설계-검토         설계        ⠈⠿⠶⠶⠶⠶⠶⠶⠶⠶⠶⡱⢎                                         막힘
문서-초안         빠른          ⠁⠂⠐ ⠂⠐ ⠂⠐ ⠂⠐ ⠂⠐ ⠂⠐ ⠂⠐ ⠂⠐ ⠂⠐ ⠂⠐⢮⡳                    제외
```

### 종료 정리 중 (stopping), t = 57.0 s

Phase `stopping`. In colour the light fades from the left end of the trunk and the lanes go dark one by one; a still shows the settled shape only. Every lane here has already settled (accepted, blocked or excluded), so the round ticks and the nodes are what is left.

```
디렉터 R3/4            ⡷1⣶⠶⠶⠶⠶⠶⠶⢶⢾⡷⠶⢶⡶⢾⢾⡷⠶⠶⠶⠶⠶⠶⡷2⠶⠶⠶⠶⠶⢶⢾⡷⢾3⠶⠶⠂ ⠂ ⠂ ⠂ ⠂ ⠂ ⠂ ⠂ ⠂ ⠂ 2m 종료 정리 중
탐색-구조         탐색   ⠹⣿⡶⢶⠶⢎⣩⣏⣉⣉⣉⣩⠼⡹⠏             ⡼⡱⠏                            승인
구현-API          구현    ⢻⢿⠶⢶⠶⡾⠶⠶⠶⢶⣽⣙⣍⣉⢎⡱⠒⠒⠒⠒⠒⠒⠒⠶⠶⠶⠾⠞                              승인
테스트-작성       검토    ⠈⢯⢯⠄⡾⠷⠶⠶⠶⣩⠞                                               승인
빌드-잡           빠른     ⠈⠛⢿⡁                                                     승인
설계-검토         설계       ⠈⠿⠶⡱⢎                                                  막힘
문서-초안         빠른         ⠁⠂⠐ ⠂⠐ ⠂⠐ ⠂⢮⡳                                        제외
```
