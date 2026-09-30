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
방·연결·터미널의 전역 개수 제한도 아직 없다. RSS를 `-Xmx`로 나눈 값을 heap 사용률로 표현하지 않는다.

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
