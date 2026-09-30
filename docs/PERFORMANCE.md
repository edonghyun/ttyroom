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
완성된 메시지의 UTF-8 100 MiB 한도와 기존 binary 정책 한도는 유지한다.
중간 text는 문자 수로 보수적으로 제한하고 완성 뒤 정확한 UTF-8 바이트를 검증한다.
text 조각의 surrogate pair, binary header 분할, 누적 한도·닫힌 연결·후속 메시지 초기화를 검증한다.
분할 수신 도중에는 인증이나 입력을 실행하지 않는다.

거대한 미완성 메시지는 여전히 실제 수신량만큼 메모리를 사용할 수 있다.
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
