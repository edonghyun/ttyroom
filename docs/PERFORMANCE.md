# 성능 측정

성능 주장은 아래 조건의 원시 결과가 있을 때만 한다. 이 문서는 T10.1의 실행 전 측정 계획이며,
운영 SLO나 최대 동시 사용자 수를 정하지 않는다. 제품 코드를 바꾸기 전에 기준선을 남긴다.

## 고정 조건과 관찰 경계

- macOS 또는 Linux, Java 21, 저장소 lockfile의 Node 도구·Chromium을 사용한다.
- 실제 경로: 단일 Spring v8 서버, SQLite, 실제 Connector 1개·zsh PTY 1개,
  Chromium 참가자 1명. 로컬 loopback이며 외부 네트워크 지연은 없다.
- 새 서버로 3회 반복한다. 매번 5회 준비 입력 뒤 20회 순차 입력을 측정한다.
  타이머는 Playwright 입력 시작부터 xterm DOM의 실행 결과 관찰까지다.
  키보드·Playwright 통신·polling 비용을 포함하므로 서버 RTT로 표현하지 않는다.
- 서버 JVM은 `-Xms256m -Xmx2g`, 어댑터 실험 JVM은 `-Xms256m -Xmx512m`이다.
  최초 서버 `-Xmx512m` 실행은 첫 입력에서 heap OOM이 발생했다. 실패 실행을 유지하고
  정상 동작의 기준선을 얻기 위해 서버 힙 조건을 변경했다. 서로 같은 환경의 성공 반복으로 합산하지 않는다.
- 같은 터미널에 512 KiB 출력을 발생시키고 완료 표식을 확인한 뒤 reload/replay를 5회 측정한다.
  reload 시작부터 마지막 표식이 DOM에 나타날 때까지이며 navigation·인증·replay·render를 포함한다.
- Spring·Connector 프로세스의 RSS를 200 ms 간격으로 기록한다. 자식 PTY·Chromium·OS 캐시는
  합산하지 않는다. 관측 최대값은 순간 peak나 Java live heap의 의미가 아니다.
- 별도 Java 어댑터 실험은 실제 `SocketSender`와 latch로 막은 가짜 transport를 사용한다.
  일반 큐의 256개 한도, 느린 수신자의 출력 drop, 64 KiB/1 MiB replay 예약·drain을 비교한다.
  네트워크·Spring 서버·브라우저가 없는 통제 실험임을 원시 파일에도 표시한다.

## 실행 전에 정한 성공 기준

- 입력 20개·replay 5개가 각 반복에서 모두 완료되고 unexpected browser error가 없다.
  개별 동작의 10초 timeout은 측정 실패 기준이며 성능 목표가 아니다.
- 막힌 write의 시작을 latch로 확인한다. 큐에는 in-flight를 포함해 256개만 수용하며
  초과 시 거절한다. 출력 drop은 control 메시지를 막지 않고 release 뒤 drain이 완료된다.
- 64 KiB/1 MiB replay 각각 5회 warmup·20회 측정, 3개 별도 JVM에서 반복한다.
- 개별 시간·실패·RSS 샘플·환경·JAR hash를 보존한다. 실패는 제외하지 않고 실행을 실패 처리한다.
  p50/p95/max는 성공 샘플의 nearest-rank로 계산하고 성공·실패 개수를 함께 표시한다.
- 정상 CI에는 correctness 테스트만 포함한다. 공유 runner의 지연 수치를 성능 gate로 삼지 않는다.

## 비교와 해석

첫 비교는 동일 구현에서 replay 크기만 바꾼 실험이다. 코드 개선 전후 효과라고 부르지 않는다.
RSS의 전후 차이는 GC·JIT·라이브러리 초기화를 포함하며 누수나 보관량만의 효과를 증명하지 않는다.
지연 분포가 겹치거나 반복별 차이가 크면 우열을 결론내리지 않는다. 병목 후보가 확인되면
프로파일링으로 원인을 좁히고 같은 조건에서 코드 변경 전후를 별도 측정한다.

## 재실행

Java 21·Node 22 이상·pnpm과 `/bin/zsh`, `ps`, `head`, `tr`, `fold`가 필요하다.
다른 빌드·테스트·부하 프로그램을 함께 실행하지 않는다. 전원·OS·런타임·heap 조건을 비교 양쪽에서 맞춘다.

```sh
pnpm install --frozen-lockfile
pnpm --filter @ttyroom/web exec playwright install chromium
./scripts/build-spring.sh
./scripts/measure-performance.sh artifacts/performance-baseline
# 동일 구현의 작은 heap 조건은 별도 실행으로 남긴다.
TTYROOM_PERFORMANCE_MAX_HEAP=512m ./scripts/measure-performance.sh artifacts/performance-512m
```

`JAVA_HOME`은 Java 21을 가리켜야 한다. 출력 디렉터리는 새 경로만 받는다.
script는 JAR를 복사하고 SHA-256·소스 snapshot·실행 환경을 남긴다. 실행 중 JAR를 덮어쓰지 않는다.
`browser-N.json`의 timing/RSS 원본과 분포, `adapter-N/*.json`의 큐·replay 원본,
표준 출력 로그와 `exit-status.txt`를 함께 보관한다. prepare/warmup/cleanup 실패도 `completed: false`다.
브라우저의 `startedAtMs`와 RSS의 `observedAtMs`는 같은 worker의 monotonic clock이다.
`observedAtMs`는 `ps`가 끝난 시점이며 샘플 사이 peak는 알 수 없다.

보고서 guard는 `pnpm --filter @ttyroom/e2e test`, 어댑터 동작은 Java test로 검증한다.
성능 수치는 별도 opt-in task이며 기본 CI에서 실행하지 않는다. v8 인증 프로세스 계약은
CI에서도 `JAVA_TOOL_OPTIONS=-Xmx512m`으로 실행해 큰 수신 버퍼의 회귀를 검출한다.

## 측정으로 발견한 수신 버퍼 문제

첫 512 MiB 힙 실행은 3회 모두 첫 출력에 도달하지 못했다. 추가 진단에서
`WsFrameBase.processInitialHeader → CharBuffer.allocate`의 heap OOM을 확인했다.
실제 Tomcat 11.0.24 JAR를 `javap -c -p`로 확인하니 세션 메시지 한도만큼 수신 버퍼를 할당했다.
기존 서버는 text와 binary 모두 100 Mi로 설정했다. text는 UTF-16 문자 버퍼이므로
작은 메시지에도 해당 방향의 큰 버퍼가 필요했다.

수정은 [RoomSocketHandler](../backend/src/main/java/dev/ttyroom/adapter/ws/RoomSocketHandler.java)의
partial callback과 [IncomingMessages](../backend/src/main/java/dev/ttyroom/adapter/ws/IncomingMessages.java)다.
Tomcat 버퍼는 text 16,384 문자·binary 16 KiB로 제한하고, 실제 수신한 조각만 누적한다.
T10.1 당시에는 완성된 text의 UTF-8 100 MiB 한도와 기존 binary 정책 한도를 유지했다.
T10.2에서는 아래와 같이 text와 inbox 한도를 줄이고 수신 중 UTF-8 바이트를 검증한다.
text 조각의 surrogate pair, binary header 분할, 누적 한도·닫힌 연결·후속 메시지 초기화를 검증한다.
분할 수신 도중에는 인증이나 입력을 실행하지 않는다.

수신 버퍼만 줄여서는 미완성 메시지의 전체 점유량과 수명이 제한되지 않아 T10.2에서 보완한다.
전체 연결 수·전체 room의 누적 메모리 상한이나 악성 연결 방어를 해결했다는 의미는 아니다.
송신 `SocketSender`는 변경하지 않았다. 어댑터 실험의 heap 값에는 Mockito·JIT·GC가 섞여 있으므로
객체별 retained size나 socket당 메모리 추정으로 사용하지 않는다.

## 최초 결과 — 2026-09-30

Apple M4 Max 16 logical CPUs·48 GiB, macOS 26.5/Darwin 25.5.0,
Java 21.0.12.1, Node 26.3.1, Chromium 151.0.7922.34에서 실행했다.
lockfile은 고정했고 실행 환경 차이는 raw JSON에 남겼다. CI의 Node 22·Linux 성능 결과는 아니다.

[공개 원시 결과](performance/baseline.json)에 실패·최초 실행·재측정을 함께 보관한다.
로컬 `artifacts/t10-1/`에는 전체 로그·manifest·복사한 JAR·라이브러리 bytecode를 보관한다.
수정 전 첫 실행 도중 Java 검증이 겹쳤으므로 동일 불변 JAR로 다른 테스트 없이 3회 재측정했다.
아래 수정 전 수치는 그 재측정이다. 숫자가 작은 실행만 고르거나 실패를 성공 표본으로 합산하지 않았다.

| 조건 (각 3회)            | 입력 p50 / p95 범위 ms    | reload/replay p50 / p95 범위 ms | 서버 RSS 관측 최대값 범위 MiB | 결과                                          |
| ------------------------ | ------------------------- | ------------------------------- | ----------------------------- | --------------------------------------------- |
| 수정 전, 최대 힙 2 GiB   | 133.2–133.9 / 136.9–139.7 | 814.9–821.5 / 823.1–823.8       | 1,149.1–2,048.7               | 입력 60·replay 15 완료                        |
| 수정 후, 최대 힙 2 GiB   | 128.8–130.9 / 135.8–136.6 | 773.8–801.7 / 785.0–805.3       | 343.0–350.4                   | 입력 60·replay 15 완료                        |
| 수정 후, 최대 힙 512 MiB | 133.1–133.5 / 136.6–137.9 | 779.2–799.6 / 798.4–817.2       | 342.9–352.0                   | 입력 60·replay 15 완료                        |
| 수정 전, 최대 힙 512 MiB | 측정 준비 실패            | 미실행                          | 비교 대상 아님                | 첫 출력 3회 실패; 추가 진단에서 heap OOM 확인 |

표의 범위는 각 반복의 p50/p95/관측 최대값을 각각 비교한 것이다. 서로 다른 반복의 p95를 평균내지 않는다.
같은 2 GiB 설정에서 서버 RSS 감소를 관찰했고, 512 MiB 실패도 수정 뒤 재현되지 않았다.
Connector RSS는 전후 약 77–81 MiB 범위였다. 수정 전 RSS 자체도 반복별 편차가 크다.
GC·RSS 샘플링 영향이 있으므로 정확한 절감률이나 동시 사용자 수로 일반화하지 않는다.
reload 표본은 반복당 5개라 p95가 max와 같으며 신뢰구간이나 통계적 유의성을 주장하지 않는다.
입력 지연은 polling·키 입력 시간 비중이 크고 512 MiB 결과까지 보면 분포가 겹친다. 속도 개선의 근거로 쓰지 않는다.

통제 어댑터 실험은 전후 모두 256개 일반 큐 한도와 64 KiB live drop 후 control drain을 만족했다.
수정 전 replay drain p95는 64 KiB에서 0.845–0.888 ms, 1 MiB에서 5.336–6.497 ms였다.
수정 후 범위는 각각 0.876–1.115 ms, 6.699–7.261 ms였다. 송신 코드는 변경하지 않았으며
이 차이는 개선 효과로 해석하지 않는다. payload 크기뿐 아니라 프레임 수도 64개에서 1,024개로 증가한다.
측정에는 가짜 transport·Mockito 호출·스케줄러·close 비용이 포함된다.

이번 병목 수정의 근거는 실제 할당 실패·수신 버퍼 설정·반복 RSS·작은 heap 재검증이다.
다중 참가자, 원격 네트워크, 장시간 부하와 전체 room의 메모리 예산은 후속 측정 범위다.

## T10.2 — 수신 자원과 참가자 수에 따른 부하 측정 계획

실행 전에 범위를 고정한다. 최대 heap 512 MiB, 참가자 1·5·10명, 각 3회 새 서버로 실행한다.
각 참가자는 독립 Chromium context를 사용한다. Connector·터미널은 여전히 각각 1개다.
입력 5회 warmup·20회 측정, 512 KiB history, 5회 동시 reload를 유지한다.
입력/복구 시간은 **모든 참가자의 DOM**에 표식이 보일 때까지다. 단일 참가자 기준선과
관찰 대상이 다르므로 증가분을 서버 처리 시간이나 사용자당 비용으로 단정하지 않는다.

```sh
TTYROOM_PERFORMANCE_PROFILE=fanout TTYROOM_PERFORMANCE_MAX_HEAP=512m \
  ./scripts/measure-performance.sh artifacts/performance-fanout
```

성공 기준은 모든 참가자의 표식 확인, unexpected browser error 없음, RSS 수집 실패 없음이다.
개별 관찰 10초·시나리오 120초 timeout 또는 프로세스 실패는 실패 표본으로 남긴다.
실패를 반복 재시도로 가리거나 더 큰 부하로 진행해 한계를 찾지 않는다.

위험 예측은 두 수준으로 구분한다.

- 코드가 강제하는 상한: text 256 KiB UTF-8, inbox 1 MiB 및 256개(in-flight 포함),
  미완성 메시지는 첫 조각부터 5초. binary 기본 1 MiB는 header 포함이며 기존 정책을 유지한다.
- 관측한 범위: 해당 장비·heap·traffic·history에서 완료율, 지연 분포, RSS 최대값을 비교한다.
  모든 단계가 성공해도 포화점을 관측한 것은 아니다. 10명 성공을 100명 안전으로 외삽하지 않는다.

기본값에서 socket당 수신 1 MiB + inbox 1 MiB + 일반 송신 1 MiB + replay 4 MiB,
터미널당 retained payload 1 MiB가 논리적 예산 항목이다. 대략 `7 MiB × socket 수 +
1 MiB × terminal 수`로 예산 증가를 검토할 수 있지만 **실제 heap/RSS 상한 공식은 아니다**.
서로 공유하는 replay payload, UTF-16·JSON 객체·복사본, 프레임 개수, JVM/native memory가 다르다.
T10.2 당시에는 방·연결·터미널의 전역 개수 제한도 없었다. 현재 정책은 아래 T10.5를 참고한다. RSS를 `-Xmx`로 나눈 값을 heap 사용률로 표현하지 않는다.

운영 경계는 동일 배포 환경에서 RSS 예산(컨테이너 제한과 JVM heap은 별도), 허용 지연,
허용 실패율을 먼저 정한 뒤 더 긴 일정 부하와 burst/reconnect에서 검증해야 한다.
현재 자료로 가능한 것은 검증한 부하 범위와 초과 시 동작 설명이며 정확한 OOM 인원 예측이 아니다.

## 참가자 fanout 결과 — 2026-09-30

[원시 결과](performance/fanout.json). 위 최초 기준선과 같은 장비·런타임에서 새 JAR의
최대 heap을 512 MiB로 고정하고 다른 빌드·테스트 없이 실행했다. 참가자 수별 새 서버 3회,
전체 9회에서 입력 180개·동시 복구 45개가 완료됐고 RSS 수집 실패는 0개다.
복구 한 번은 해당 단계의 모든 참가자 reload를 뜻한다. 브라우저별 관찰을 독립 요청 표본으로 부풀리지 않는다.

| 참가자 수 | 입력 p95 범위 ms | 동시 복구 p95 범위 ms | 서버 RSS 관측 최대값 범위 MiB |
| --------- | ---------------- | --------------------- | ----------------------------- |
| 1         | 133.0–136.8      | 771.0–808.7           | 342.3–352.4                   |
| 5         | 144.2–145.5      | 577.4–823.3           | 350.1–360.4                   |
| 10        | 166.7–171.9      | 1,149.7–1,236.5       | 357.2–366.2                   |

각 셀은 반복별 p95 또는 최대값의 최소–최대다. 5회 복구 표본의 p95는 max다.
5명 복구의 편차와 1명보다 낮은 값도 그대로 보존하며 선형 모델을 맞추지 않는다.
Connector RSS 관측 최대값은 전체 71.3–81.0 MiB였다. 같은 컴퓨터의 여러 Chromium context,
키 입력 및 DOM polling 비용도 지연에 포함된다.

**확인된 범위는 터미널 하나의 출력을 함께 보는 10명까지의 짧은 로컬 시나리오**다.
10개 터미널의 동시 출력, 다중 room, 느린 클라이언트, 원격 네트워크, 장시간 누적 부하의 결과가 아니다.
매 입력마다 모든 DOM을 기다리는 순차 부하이므로 일정 유입률을 주는 open-loop 포화 시험도 아니다.
이 범위에서 OOM·timeout은 없었지만 최대 수용량이나 장시간 메모리 안전을 증명하지 않는다.

위험 수준을 예측하려면 다음 측정은 동일 배포 사양에서 동시 terminal 수와 출력 bytes/s를
각각 늘리며 GC 후 live heap·GC pause·CPU·queue 대기·실패율을 함께 기록해야 한다.
처리율보다 유입률이 크면 `잔여 queue 용량 / (유입률 − 처리율)`로 포화까지의 시간을
대략 계산할 수 있다. byte/s와 command/s를 각각 같은 단위로 적용해 더 이른 한도를 사용한다.
이는 유입·처리율이 일정하다는 조건의 추정이며 이번 표가 그 처리율을 측정했다는 뜻은 아니다.
전역 room/connection/terminal admission 예산까지 강제한 뒤 그 경계 안에서 운영 한도를 정한다.

## T10.3 — 포화 구간 측정 계획

실행 전 고정한 로컬 실험 조건이다. 운영 SLO나 제품 최대 수용량으로 선언하지 않는다.
실제 Spring v8·SQLite·WebSocket에 합성 호스트와 수신자 5개를 연결한다.
합성 호스트가 보낸 4 KiB payload의 timestamp·sequence를 수신자가 검사한다.
실제 Connector·PTY·React rendering은 이 실험에 포함하지 않는다. 이전 브라우저 fanout과 합산하지 않는다.

- Java 21 G1, `-Xms256m -Xmx512m`. 출력 부하는 terminal당 64/256/1024 KiB/s로 조절한다.
- 단계는 `(terminal 수, host 수, terminal당 KiB/s)` = `(1,1,64)`, `(1,1,256)`,
  `(4,1,256)`, `(16,1,256)`, `(16,4,1024)`다. 마지막 단계의 총 출력은 16 MiB/s다.
  실제 Connector의 throttling을 검증하는 시험은 아니다.
- 단계마다 새 서버 3회, 5초 warmup 후 20초 측정. 응답을 기다리지 않고 10 ms tick의
  경과 시간에 따라 송신량을 결정한다. 뒤처진 송신을 성공한 낮은 부하로 보고하지 않는다.
- 제어 probe는 100 ms 간격의 존재하지 않는 terminal 제어권 요청이다. 큐 처리·응답을
  관찰하지만 durable write 부하를 대표하지 않는다.
- 실험 통과 기준: 정상 수신자의 누락·중복·순서 오류·gap·종료 0, 출력 p95 ≤100 ms,
  제어 p95 ≤250 ms, 개별 최대 ≤1000 ms. 지연 histogram은 고정 크기의 1 ms 상한 bucket이다.
- 즉시 중단: 정상 연결 오류/연속성 손실, 지연 최대 1초 초과, generator 지연 250 ms 초과,
  generator socket backlog 1 MiB 초과, 서버 RSS 768 MiB 또는 generator RSS 512 MiB 초과,
  RSS 관찰 실패. 각 대기는 유한하며 종료하지 못한 단계도 원본에 보존한다.
- 한 단계라도 실패하면 더 높은 부하로 진행하지 않는다. 모든 단계가 성공해도 유한한 상한까지만
  시험한 결과이며 포화점을 찾았다고 표현하지 않는다.
- ladder 뒤 별도 조건으로 4 MiB/s·16 terminal을 5분 유지한다. ladder에서 실패했다면
  3회 모두 통과한 더 낮은 단계로 내린다. 5분은 장기 누수 안전의
  증거가 아니다. 느린 수신자 1개 추가와 5개 수신자의 동시 재접속은 각각 독립 실행한다.
  느린 수신자는 socket read를 멈추고 정상 5개 수신자는 계속 읽는다. 재접속은 모든 terminal의
  retained payload와 sync가 5초 안에 복구돼야 한다.

JFR에는 CPU load, GC pause·heap summary, control enqueue부터 worker 시작까지의 대기,
버퍼 drop·거절만 활성화한다. 제품의 custom event는 기본 비활성이고 stack·ID·credential·내용을
기록하지 않는다. 시작 시 event type 등록과 command당 event 참조 하나는 비활성일 때도 존재한다.
계측 비용은 같은 1 terminal·256 KiB/s 조건에서 JFR ON/OFF 각각 3회로 비교한다.
OFF에도 event type 등록·Command 참조가 있으므로 계측 코드 추가 전과의 전체 비용 비교는 아니다.
QueueWait는 실제 실행을 시작한 명령만 기록한다. 폐기된 명령은 지연 분포에 없으며,
같은 live frame에서 `rejected`와 `live-drop`이 모두 기록될 수 있어 두 카운터를 합산하지 않는다.
RSS sampler는 1초마다 직렬로 실행하며 호출 시간·누락을 남긴다.

강제 GC와 `GC.heap_info`는 빈 history, 적재 후, host 취소·5초 cooldown 뒤에만 호출하고
timed traffic에서 제외한다. 이는 진단을 위해 수명을 확인한 post-full-GC heap이며 자연 GC와
구분한다. timed 구간의 JFR `After GC` heap도 전체 live set의 정밀 크기라고 단정하지 않는다.
JFR CPU는 전체 기계 대비 JVM CPU 비율이고, RSS는 JVM heap·native를 포함한 프로세스 관측값이다.

```sh
./scripts/build-spring.sh
TTYROOM_CAPACITY_PROFILE=smoke ./scripts/measure-capacity.sh artifacts/capacity-smoke
./scripts/measure-capacity.sh artifacts/capacity-full
```

Java 21의 `JAVA_HOME`, `jcmd`, `jfr`, `ps`가 필요하다. 새 출력 디렉터리만 사용한다.
JAR·JFC·source hash를 고정하고 다른 빌드·테스트 없이 실행한다. 각 실행은 결과 JSON, JFR 원본,
선택 event의 JSON, GC 진단 원문을 남긴다. 실패한 smoke는 환경·harness 진단이며 성능 표본과 섞지 않는다.

### 측정 중 확인한 조건과 후속 계획

첫 `full` 실행에서 느린 수신자 시험은 drop/close를 관측하지 못해 실패 처리했다.
같은 JAR의 재현 handshake에서 `permessage-deflate` 협상을 확인했다. 반복적인 `x` payload를
쓰는 최초 단계의 MiB/s는 압축 전 application payload이며 실제 TCP byte/s가 아니다.
최초 실행은 연결별 협상 결과를 저장하지 않았으므로 별도 확인 결과와 구분한다.

연속 출력은 성공했으나 16 terminal 동시 재접속에서 `replay:rejected` 이벤트 5개를 관찰했다.
기존 결과는 보존하고 `recovery` profile에서 압축을 끈 느린 수신자와 3→4→16 terminal
재접속을 각각 확인한다. 각 재접속 단계는 새 서버 3회이며 첫 실패 뒤 더 큰 workspace로
진행하지 않는다. 새 실행은 협상 extension, 참가자별 실패 이유, terminal별 replay byte 수와
sequence/sync 연속성을 확인한다. 이는 최초 실행의 재시도가 아닌 분리한 원인 확인 실험이다.

```sh
TTYROOM_CAPACITY_PROFILE=recovery ./scripts/measure-capacity.sh artifacts/capacity-recovery
```

관찰 도구 리뷰에서 늦은 샘플이 이전 histogram 관찰값을 변경하는 문제도 찾아
snapshot 회귀 테스트의 실패를 확인한 뒤 복사하도록 수정했다. 최초 성공 부하 실행은
모든 응답 drain 후 관찰했으며, 원본의 histogram 합계와 count를 별도로 대조한다.
등록·취소 fixture의 HTTP 대기에도 5초 timeout을 추가했다. 성능 측정에는 사용한 소스
snapshot commit과 hash를 각각 명시해 보완 전후 도구를 섞지 않는다.

### T10.3 측정 결과 — 출력보다 먼저 드러난 복구 한도

2026-09-30, Apple M4 Max·논리 CPU 16개·48 GiB RAM·macOS 25.5.0,
Java 21.0.12.1·Node 26.3.1에서 실행했다. [공개 관측 JSON](performance/capacity.json)에
최초 21회와 원인 확인 5회 모두를 보존한다. 성공 사례만 골라낸 표본이 아니다.
최초 소스 snapshot은 `aaac2dd`, 보완한 도구는 `dbf2bbe`이며 제품 JAR SHA-256은 같다.
포함한 소스 hash를 각 commit과 대조했다. 전체 JFR·진단 원문·로그는 로컬
`artifacts/t10-3/{full-1,recovery-1}/`에 있고 공개 JSON에 원본 hash를 남긴다.

| 조건: terminal / host / 총 payload 유입률 | 반복·시간   | 출력 p95 상한 | 제어 p95 상한 | 프로세스 RSS 최대 |
| ----------------------------------------- | ----------- | ------------- | ------------- | ----------------- |
| 1 / 1 / 64 KiB/s                          | 3회 × 20초  | 3 ms          | 3 ms          | 328.9–365.3 MiB   |
| 1 / 1 / 256 KiB/s                         | 3회 × 20초  | 2–3 ms        | 3 ms          | 356.8–365.9 MiB   |
| 4 / 1 / 1 MiB/s                           | 3회 × 20초  | 4 ms          | 3–4 ms        | 349.9–365.3 MiB   |
| 16 / 1 / 4 MiB/s                          | 3회 × 20초  | 6 ms          | 3–5 ms        | 444.3–462.3 MiB   |
| 16 / 4 / 16 MiB/s                         | 3회 × 20초  | 6 ms          | 3 ms          | 463.5–476.8 MiB   |
| 16 / 1 / 4 MiB/s                          | 1회 × 300초 | 6 ms          | 3 ms          | 474.6 MiB         |

모두 정상 수신자 5명이며 출력 누락·중복·순서 오류·gap·종료가 없었다. RSS 최대는
warmup·부하·진단·해제까지의 전체 관찰 구간, 지연·CPU·GC pause는 timed load 기준이다.
최고 단계는 수신 frame 409,600개/회, 5분 실행은 1,536,000개를 확인했다.
최고 단계의 GC pause 최대는 반복별 3.77/3.95/3.08 ms, JVM CPU 관찰 최대는 기계 전체의
5.1–5.3%였다. 5분 실행의 GC pause 최대는 7.52 ms, 출력 지연 최대는 23.52 ms였다.
제어 queue 대기 p95는 두 조건 모두 1 ms 이하였다.

최고 단계의 강제 GC 후 heap은 빈 상태 17.0–17.1 MiB → history 적재 32.6–32.7 MiB →
host 취소·cooldown 후 15.7–15.8 MiB였다. 5분 실행은 16.7 → 32.2 → 15.7 MiB다.
보유 history가 해제되는 것은 확인했지만 시간에 비례하는 모든 누수가 없다는 증거는 아니다.
이 ladder는 정해 둔 최고 단계까지 성공했으므로 **연속 출력의 포화점은 찾지 못했다**.
압축 가능한 합성 출력의 결과를 실제 PTY의 무작위 데이터 처리량이나 인터넷 수용량으로 바꾸어 읽지 않는다.

계측 비교 조건의 JFR ON 3회는 출력 p95 2–3 ms·제어 3 ms·RSS 최대 356.8–365.9 MiB,
OFF 3회는 2 ms·2–3 ms·343.0–345.9 MiB였다. 별도 JVM의 짧은 순차 실행이라 RSS 차이를
JFR의 고정 비용으로 확정하거나 통계적 유의성을 주장하지 않는다. 전체 실행의 RSS 수집 실패와
JFR DataLoss는 0이며 sampler 호출 최대는 42.0 ms였다. 각 timed recording의 queue event 수와
제어 응답 수, 모든 histogram 합계와 count를 대조했다. OFF 실행에는 JFR 수치가 없다.

압축을 끈 별도 느린 수신자 시험에서는 정상 5명이 102,400개 frame을 모두 받았고,
읽기를 멈춘 연결은 종료됐다(클라이언트 관측 1006). timed load의 `live-drop` 192개와
`outbound:rejected` 192개는 같은 frame의 두 관찰이므로 합산하지 않는다. warmup 등까지 포함한
전체 recording에서는 각각 4,861개였다. 이 실험은 연결 격리를 확인하며 정확한 서버 close code나
gap 전달 성공을 확인한 것은 아니다. 최초 압축 조건에서 fault를 만들지 못한 실패도 그대로 보존했다.

| history가 terminal마다 1 MiB인 동시 재접속 | 결과                                         | 복구 시간 / 원인         |
| ------------------------------------------ | -------------------------------------------- | ------------------------ |
| 3 terminal × 5명                           | 3회 모두 5명 복구, 총 15 MiB/회              | 31.08 / 31.70 / 32.48 ms |
| 4 terminal × 5명                           | 첫 실행에서 5명 모두 실패, 더 높은 단계 중단 | `replay:rejected` 5개    |
| 최초 16 terminal × 5명                     | 5명 모두 실패                                | `replay:rejected` 5개    |

3 terminal에서는 terminal별 byte 수·sequence·sync 연속성도 확인했다. 실패한 두 조건은
현재 replay 예약량이 3,152,763 bytes·3 requests인 시점에 다음 예약을 거절했다.
이 payload 구성에서는 terminal 하나가 `1,048,576 + 256 × 9 + 41 = 1,050,921 bytes`
(payload + binary frame header + sync)를 예약한다. 네 개면 4,203,684 bytes로
연결별 4 MiB 한도 4,194,304 bytes를 넘는다. 앞선 예약이 먼저 drain되면 상황이 달라질 수 있으므로
모든 4-terminal 접속이 항상 실패한다고 일반화하지 않는다. 측정한 실패는 **heap OOM이 아니라
정상 복구 작업과 연결별 예약 정책의 충돌**이다. replay event는 timed load 이후에 발생하므로
공개 JSON의 `recordingPressure`에서 별도로 확인한다.

### 전역 자원 예산 후보와 적용 순서

T10.3 측정 시점에는 전역 admission 제한을 구현하지 않았다. 아래는 운영 보장이 아닌 **후속 구현·검증을 위한
제한된 pilot 후보**이며, [T10.4](https://github.com/edonghyun/ttyroom/issues/14)에서 복구 경계를
먼저 고쳐야 한다. 단순히 replay 한도를 올려 실패를 숨기지 않는다.

| 항목                                  | 후보 / 근거와 제한                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| JVM heap / RSS 중단선                 | 512 MiB / 768 MiB. 이번 실험 설정이며 container 한도 검증은 아니다.                                              |
| 동시 room / 참가자 / host             | 1 / 5 / 최대 4. 측정한 차원 안의 후보이며 다중 room·연결 churn은 미검증이다.                                     |
| 복구를 요구하는 full-history terminal | 수정 전 임시 후보 3개. 3회 성공한 국소 범위이며 제품의 목표 한도가 아니다.                                       |
| 지속 출력 후보                        | terminal당 256 KiB/s. 3개에서 20초 후 복구, 16개에서 5분 부하를 각각 확인했다. 조합 전체의 장시간 검증은 아니다. |

참가자 5명+host 4명, terminal 3개라면 기존 논리 예약 항목은
`7 MiB × 9 sockets + 1 MiB × 3 terminals = 66 MiB`다. 이 합은 객체·frame 개수·JSON 복사·
TLS/native·JVM 기본 비용을 포함하지 않고 payload 공유도 반영하지 않으므로 heap/RSS의 상한이 아니다.
숫자만으로 OOM 발생 인원을 계산하지 않는다. 실제 전역 정책은 개수와 byte 예산의 예약·반납,
초과 요청 거절 및 정상 연결 격리를 함께 구현하고 같은 배포 사양에서 다시 검증해야 한다.

위험 예측에는 live 지연뿐 아니라 replay 거절, control queue 대기, drop, GC 후 잔류 heap,
RSS 증가를 함께 사용한다. 이번에는 live 지연이 낮아도 복구가 먼저 실패했다. 아직 측정하지 않은
다중 room, 작은 frame 폭주, durable write 경합, 원격망, 장시간 연결 churn의 안전선은 남겨 둔다.

## T10.4 — 연결별 예산을 유지한 workspace 복구

T10.3의 4-terminal 실패를 수정한 뒤 같은 `recovery` profile로 재측정한다.
조건은 압축 비활성·1 MiB retained history/terminal·참가자 5명 동시 재접속이며,
3→4→16 terminal 각 새 서버 3회, 첫 실패 뒤 더 큰 단계 중단 규칙을 유지한다.
20초 출력 부하와 진단을 마친 뒤 reconnect를 측정하며 전체 수신 byte 수·sequence·sync를 검사한다.
별도 느린 수신자 1명 격리도 포함한다. 실제 Connector·PTY·브라우저 시험과는 구분한다.

수정은 terminal별 최종 sync write가 완료되고 예약을 반납한 뒤 다음 history를 선택하는 방식이다.
한 연결의 입장 복구가 한 번에 모든 history를 붙잡지 않으며, 아직 선택하지 않은 terminal은 ID만
보관한다. 기존 replay 4 MiB·65,536 frames·16 requests와 5초 write timeout은 바꾸지 않았다.
terminal 하나의 history가 설정에 의해 그 예산을 넘으면 기존처럼 거절한다.
T10.4 시점의 전역 terminal 수·retained history 총량은 후속 T10.5에서 제한한다. 명시적 resync 요청 폭주는 별도 제한 대상이다.

실행 snapshot은 `36f7568`이다. T10.3 recovery와 harness source는 같고 제품 JAR은 다르다.
불변 JAR·source hash와 실패 원본을 남기며 다른 로컬 빌드·테스트와 겹치지 않게 실행한다.

같은 macOS·M4 Max·Java 21·최대 heap 512 MiB 환경에서 **10개 시나리오 모두 완료**했다.
[개별 관측 JSON](performance/recovery.json)에 조건·소스/JAR hash·histogram·RSS·GC·heap·CPU·실패 목록을 보존한다.

| terminal 수 × 동시 재접속자 | 반복 결과 | 전체 복구 시간            | 수신 payload/회 |
| --------------------------- | --------- | ------------------------- | --------------- |
| 3 × 5명                     | 3/3 성공  | 32.22 / 31.73 / 34.42 ms  | 15 MiB          |
| 4 × 5명                     | 3/3 성공  | 30.76 / 42.63 / 43.28 ms  | 20 MiB          |
| 16 × 5명                    | 3/3 성공  | 73.25 / 115.47 / 82.21 ms | 80 MiB          |

이전 같은 recovery 조건의 4 terminal은 첫 실행에서 전원 실패했다. 수정 후에는 9회의 재접속
모두 5명이 terminal별 1 MiB와 연속된 sequence·sync를 복구했다. 전체 JFR recording에서
`replay:rejected`는 0개였다. 통과한 최대 16개를 제품 최대 수용량으로 선언하지 않는다.

압축 없는 느린 수신자 시험도 정상 5명이 모든 102,400 frame을 받았고 느린 연결만 종료됐다
(클라이언트 관측 1006). timed load의 `live-drop`과 `outbound:rejected` 각각 192개,
전체 recording 각각 4,861개는 같은 frame에 대한 두 관찰이므로 합산하지 않는다.

16-terminal 실행의 RSS 관찰 최대는 반복별 385.8 / 363.8 / 393.5 MiB,
강제 GC 후 heap은 빈 상태 16.4–16.6 → history 적재 32.0 → 해제 16.0–16.1 MiB였다.
RSS 수집 실패·JFR DataLoss는 없었고 frame 수·histogram 합계·제어 응답/queue event 수를 대조했다.
이것은 같은 짧은 부하의 복구 결함 수정 근거이며 장시간 누수·원격망·다중 room 검증은 아니다.
T10.3의 수정 전 임시 3-terminal 후보는 이제 실패 회피 기준으로 사용할 필요가 없지만,
이후 #15에서 전역 admission 정책을 추가했다. 실제 배포 사양의 운영 상한 검증은 남아 있다.

## T10.5 — 전역 admission 경계

Spring의 기본 후보는 저장된 방 4개, 물리 WebSocket 16개, 저장된 terminal 16개,
retained payload 예약 16 MiB다. 소유자·저장 실패·종료·재시작 규칙은
[설정 안내](DEVELOPMENT.md#전역-admission-예산-spring)에 정의한다.
연결별 inbox·송신·replay 예산은 변경하지 않았다.

재현 명령:

```sh
JAVA_HOME=/path/to/jdk21 TTYROOM_CAPACITY_PROFILE=admission \
  ./scripts/measure-capacity.sh artifacts/capacity-admission
```

프로필은 불변 JAR, Java 21, G1, `-Xms256m -Xmx512m`를 사용한다. 다른 로컬 빌드·테스트와
겹치지 않게 실행한다. 한 프로세스에 4개 방, 방마다 host 1명·participant 3명·terminal 4개를
만들어 16개 연결·16 MiB retained payload를 채운다. 첫 초과 방/terminal/connection을 거절한 뒤
모든 방의 제어 응답을 확인한다. 12명이 순차로 접속하는 복구 round를 초기 1회와 churn 10회
실행한다. 동시 재접속 부하의 대체 시험은 아니다. host 취소로 전역 terminal 예약을 반환한 뒤
새 host가 16개를 다시 등록할 수 있는지도 확인한다. 동일 조건 3회 반복한다.

GC 후 heap(빈 상태/적재/연결 churn 후/host 제거 후), RSS, JFR queue 대기·buffer 거절·drop,
복구 bytes·sequence·sync를 기록한다. raw 결과는 artifacts에, 공개 관측은
`docs/performance/admission.json`에 보존한다. 결과는 아래에 기록한다.

이 측정은 macOS 로컬 합성 peer의 유한 실행이다. 실제 배포 사양은 아직 제공되지 않았으므로
배포 환경 검증과 운영 상한 결정은 #15의 미완료 항목으로 남긴다. credential 발급 수,
고유 identity churn과 grace metadata, HTTP/TCP 연결 수는 이 admission 예산으로 제한되지 않는다.
따라서 전체 서버 OOM 방지나 장시간 누수 부재를 보장하지 않는다.

### 로컬 경계 측정 결과

[공개 JSON](performance/admission.json)의 3회 모두 완료했다. 측정은 `c33c706` 이후 작업 중인
소스에서 실행했으며 manifest의 `dirty: true`, 제품 소스/JAR/harness hash로 구분한다.

| 반복 | 적재 / churn 후 / 해제 후 GC heap | 관측 최대 RSS | 12명 순차 복구 round 범위 |
| ---- | --------------------------------- | ------------- | ------------------------- |
| 1    | 33.78 / 33.76 / 16.79 MiB         | 440.11 MiB    | 730.65–790.68 ms          |
| 2    | 33.31 / 33.83 / 16.59 MiB         | 469.09 MiB    | 729.77–790.59 ms          |
| 3    | 33.37 / 33.68 / 16.68 MiB         | 433.80 MiB    | 736.49–792.17 ms          |

각 round는 48 MiB를 복구한다. 총 33 round·396개 participant 연결에서 기록 수신과
sequence·sync를 확인했다. 각 실행의 방/terminal/connection 첫 초과 요청은 각각
HTTP 503 / `capacity-exhausted` / close 1013으로 거절됐다. 정상 방 모두의 제어 응답을 확인했다.
JFR queue event는 실행별 142개, p95 상한 1 ms였다. buffer drop/rejection event,
RSS 수집 실패, JFR DataLoss는 0이었다. admission 거절은 JFR buffer 거절과 다른 경계이며
공개 JSON의 `rejections`에 wire 응답으로 기록한다.

강제 GC 후 heap은 빈 서버 14.17–14.28 MiB였고 해제 후에는 16.59–16.79 MiB였다.
그 차이를 전부 누수로 판정하거나 전부 정상으로 확정하지 않는다. warmup, 등록된 credential,
참가자의 grace metadata 등이 남아 있고 10회 churn만으로 장시간 잔류 추세를 판단할 수 없다.
이번 결과는 설정된 예산의 거절·반납과 다중 방 복구를 확인하며, 이전 지속 출력 시험과
조합한 전역 최대 부하·원격망·배포 사양 검증은 아니다.

## T10.6 — credential 보관과 유예 상태

`capacity.credentialsPerRoom=64`, `capacity.credentials=128`은 manager를 포함한 보관 수다.
16개 연결을 사용할 때 미접속·재접속용 credential의 여유를 두고, 방 4개가 각각 64개를 채우는
것은 전역 128개에서 제한한다. 측정으로 도출한 최대 수용량이나 최적값이 아닌 보수적인 초기 정책이다.
권한 검사·저장 실패·취소·재시작 수명은 [설정 안내](DEVELOPMENT.md#credential-발급보관-예산)에 정의한다.

```sh
JAVA_HOME=/path/to/jdk21 TTYROOM_CAPACITY_PROFILE=credentials \
  ./scripts/measure-capacity.sh artifacts/capacity-credentials
```

불변 JAR, Java 21/G1 `-Xms256m -Xmx512m`, macOS 로컬에서 다른 빌드·테스트와 겹치지 않게
실행한다. 실제 PTY·브라우저 대신 합성 HTTP/WS peer를 사용한다. 방 2개를 각각 manager 1명,
계속 접속하는 participant 1명, 추가 participant 62명으로 채운다. 총 128개 credential이다.
이 상태에서 새 방의 manager 발급과 기존 방의 participant 발급을 거절하는지 확인한다.

방마다 credential 하나를 100회 취소·재발급해 보관 수를 유지한다. 이후 방별 62개 고유 identity를
차례로 연결·종료하고 기본 15초 grace의 joined/left 알림을 전부 수집한다. keeper를 재접속해
snapshot에 1명만 남는지 확인한다. 각 방은 차례로 시험하며, keeper가 방 삭제를 막는다.
마지막으로 추가 credential 124개를 취소해 manager와 keeper 총 4개만 남긴다.

발급은 HTTP 응답까지, 취소는 HTTP와 해당 주체의 삭제 알림까지, 인증은 WS 연결과 welcome까지의
클라이언트 관측 지연이다. 인증 탐색 함수만의 실행 시간이 아니며 10 ms polling도 포함한다.
빈 상태/최대 credential/발급 churn/유예 종료/취소 후 강제 GC heap과 SQLite 파일·sidecar 크기를
기록한다. 파일 크기는 SQLite가 재사용하는 빈 페이지까지 포함하므로 논리 보관 항목 수와 다르다.
JFR queue/pressure·RSS 수집 오류도 확인한다. 동일 조건을 3회 반복한다.

v8의 공개 등록·입장·취소 경로에서는 membership이 발급된 identity에 연결되고 취소가 membership과
유예 타이머를 정리한다. v7은 credential 없이 임의 ID로 입장하므로 이 예산의 보호 대상이 아니다.
특성화 테스트에서는 저장 credential 1개 상태에서도 연결을 차례로 바꿔 grace membership 4개가
남았고 expiry 후 1개로 줄었다. 이미 실행 큐에 전달된 expiry 작업과 HTTP 요청 대기열도 별도 경계다.
전체 heap 상한이나 장시간 누수 부재, 배포 환경 성능을 보장하지 않는다.

### 관측 결과

[공개 JSON](performance/credentials.json)의 최종 3회 모두 완료했다. `9feb1bb` 이후 작업 중인
소스로 실행했으며 manifest에 `dirty: true`와 제품/JAR/harness hash를 기록했다.

| 반복 | 최대 credential / 발급 churn / grace 후 / 취소 후 GC heap | 최대 관측 RSS | 발급 / 취소 / 연결+welcome p95 상한 |
| ---- | --------------------------------------------------------- | ------------- | ----------------------------------- |
| 1    | 16.25 / 15.71 / 15.78 / 15.85 MiB                         | 388.64 MiB    | 6 / 17 / 25 ms                      |
| 2    | 16.33 / 15.95 / 16.21 / 15.93 MiB                         | 355.59 MiB    | 6 / 16 / 24 ms                      |
| 3    | 16.26 / 15.73 / 15.80 / 15.97 MiB                         | 350.95 MiB    | 6 / 16 / 25 ms                      |

회당 발급 326회, 취소 324회, 연결+welcome 128회를 관찰했다. 취소 지연 최대는 반복별
230.06 / 36.29 / 23.78 ms였다. p95만으로 최악 지연을 감추지 않는다.
각 방은 grace 중 최대 participant 63명, joined/left 각각 62회, grace 후 keeper 1명을 관찰했다.
모든 방의 keeper가 제어 요청에 응답했다. 추가 방/participant 발급은 모두 503으로 거절됐다.

SQLite 파일은 빈 상태 12 KiB에서 128개 적재 후 44 KiB가 됐고 발급 churn·grace·취소 후에도
44 KiB였다. 보관 항목을 취소해도 물리 파일이 즉시 줄어든다고 가정하지 않는다. 기록된 바이트는
파일 크기이며 DB의 논리 사용량·vacuum 결과를 측정한 것은 아니다. RSS 수집 실패·JFR DataLoss·
buffer pressure event는 0이었다. JFR queue event는 회당 제어 probe 2개이며 대량 제어 부하가 아니다.

최초 측정은 이전 취소 단계의 `participant-left` 알림 100개를 grace 만료로 잘못 집계해 실패했다.
그 결과와 source hash도 공개 JSON의 `diagnosticRun`에 보존했다. 수정 후에는 각 취소 알림의
주체를 확인하고 소비한 뒤 다음 단계로 넘어간다. 이 도구 오류를 서버 메모리 누수나 제품 RED로
해석하지 않는다. v7 임의 identity와 대기 expiry 작업의 후속 범위는 [#17](https://github.com/edonghyun/ttyroom/issues/17)에 등록했다.

## T10.7 — membership과 만료 대기

기본 membership 예산은 접속 중·유예 중을 합쳐 방별 64개·전체 128개다. v7/v8 모두 적용하고
만료 실행은 방당 1개·전체 4개로 제한한다. 이 값은 저장 credential과 별도의 초기 정책이며,
운영 수용량을 측정해 얻은 최적값이 아니다. 네 개의 서로 다른 방에서 저장이 막히면 후속 만료도
대기한다. 전체 대기 수는 membership 예산, 실행 수는 worker 전달 예산으로 제한한다.

`ExpiryStorageTests`는 실제 RoomSessions/RoomDirectory/ExpiryTimers와 gate를 둔 RoomStore를
사용한다. 첫 방에 keeper 1명과 host 63명을 입장시키고 host들을 모두 종료한다. 첫 만료의
`RoomStore.save`를 막은 동안 다른 방의 host 제거가 완료되는지 확인한다. 저장 해제 뒤 첫 방의
63개 제거 알림과 영속 모델의 빈 host 목록, 종료 뒤 저장소 close와 잔류 작업을 관찰한다.
실제 SQLite 디스크 지연이나 원격망 부하가 아니라 애플리케이션 저장 경계의 유한 실패 주입이다.

```sh
JAVA_HOME=/path/to/jdk21 ./backend/gradlew -p backend test --tests '*ExpiryStorageTests'
```

[공개 결과](performance/expiry.json)의 3회 모두 저장 대기 중 **62개 작업 보관**, 다른 방 정리 성공,
저장 해제 후 host **63개 제거**, 종료 뒤 **대기 0개·실행 0개**를 확인했다. timer 내부 집합은
fixture에서 monitor를 잡고 관찰했다. 이 구조 의존성은 격리 실험을 위한 것이며 공개 API 계약은 아니다.
JSON의 microsecond 값은 진단용 관측 시간이다. 다른 로컬 작업과 겹칠 수 있는 테스트 실행이므로
p95/처리량·운영 지연 기준으로 사용하지 않는다. heap/RSS/JFR·장시간 churn은 이 실험에서 측정하지 않았다.

별도 행동 테스트는 실행 중 저장의 종료 대기, 대기 작업 취소, 같은 방 격리, 전역 실행 포화 후
정리 재개와 막힌 방 뒤에서 timer를 **1,000회 생성·중복 취소한 후 보관 0개**를 확인한다.
Spring 프로세스 테스트는 v7의 방별/전역 초과 입장, 다른 방의 응답, 유예 종료 뒤 슬롯 재사용,
v8의 같은 credential 교체와 취소 후 새 주체 입장을 확인한다.

HTTP/TCP 요청률·제어 요청 대기와 실제 배포 사양 검증은 남아 있다. 저장 예외가 난 만료를 자동으로
무한 재시도하지 않는다. 기존 저장 실패 보존 계약과 재접속/취소 복구를 유지하며, 저장의 영구 정지가
생기면 만료 완료와 graceful shutdown 시간도 보장하지 않는다.

추가 특성화에서 v7 신규 host의 저장 뒤 welcome 실패를 3회 반복하면, live membership 예산 2개와
별개로 영속 host 3개·만료 callback 0개가 남았다. 이 기존 경로의 보관/복원 한도는
[#18](https://github.com/edonghyun/ttyroom/issues/18)에 분리했다. 이번 결과를 모든 identity 보관 경로의 상한으로 확대하지 않는다.
