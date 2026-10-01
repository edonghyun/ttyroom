# Benchmarks

`@ttyroom/benchmarks`는 부하 생성, JVM 관측, 결과 분석과 격리 환경을 소유한다.
`e2e`는 HTTP/WS 기능 계약을 검증하고, `test-support`는 양쪽과 브라우저 테스트가 사용하는
서버 프로세스·소켓·자원 정리 도구를 제공한다. 서버 내부 구현은 import하지 않는다.

| 위치                         | 책임                                      |
| ---------------------------- | ----------------------------------------- |
| `benchmarks/src/*-run.ts`    | 명시적으로 실행하는 측정 시나리오         |
| `benchmarks/src/*-report.ts` | 관측값 집계·성공/실패 판정                |
| `benchmarks/src/*.spec.ts`   | 계측 코드의 빠른 회귀 테스트              |
| `benchmarks/docker/`         | Linux 격리 측정 환경                      |
| `web/e2e/performance/`       | 실제 브라우저·Connector·PTY 성능 시나리오 |
| `artifacts/<실행 이름>/`     | 실행별 원시 증거, 실패·정리 기록          |

브라우저 fixture는 React·Playwright 실행을 소유하는 `web`에 둔다. 결과 집계만 이 패키지의
`@ttyroom/benchmarks/report` 공개 경로를 사용한다. `pnpm test`는 계측 코드의 단위 테스트만
실행한다. 서버를 띄우는 부하 실험과 Docker 실행은 자동으로 시작하지 않는다.

## 실행 환경

저장소 루트에서 실행한다. Java 21로 JAR를 먼저 빌드하고, 실행 중에는 다시 빌드하지 않는다.

```sh
JAVA_HOME=/path/to/jdk21 ./backend/gradlew -p backend test bootJar

# 기존 로컬 JVM 측정: JVM과 generator가 호스트에서 실행된다.
JAVA_HOME=/path/to/jdk21 TTYROOM_CAPACITY_PROFILE=smoke \
  pnpm --filter @ttyroom/benchmarks bench:local artifacts/local-smoke

# Linux 컨테이너 격리 확인. 처리량 측정이 아니다.
pnpm --filter @ttyroom/benchmarks bench:docker artifacts/docker-smoke

# 짧은 출력 단계: 계측·중단·정리 도구 검증
pnpm --filter @ttyroom/benchmarks bench:docker artifacts/docker-pilot pilot

# 출력 단계별 30초 예열 + 60초 측정, 각 3회
pnpm --filter @ttyroom/benchmarks bench:docker artifacts/docker-output output
```

Docker 실행은 Docker Desktop/Engine과 Linux cgroup v2가 필요하다. 최초 실행은 Java 21 및
Node 22 이미지를 다운로드한다. 이미지 ID·아키텍처·실제 자원 설정과 불변 JAR hash를 기록한다.

| 환경              | 설정·데이터·네트워크                                                              | 자원                                                              |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 개발              | 개발자가 선택한 설정과 `.ttyroom`                                                 | 호스트 자원                                                       |
| 기능 E2E          | 실행별 임시 설정/SQLite, 임의 localhost 포트                                      | 호스트 자원                                                       |
| 로컬 JVM 벤치마크 | 실행별 임시 SQLite, 새 결과 디렉터리, 복사한 JAR                                  | 고정 JVM 옵션, 호스트 CPU 공유                                    |
| Docker 측정       | 고유 Compose project·내부 네트워크·새 DB volume, 호스트 포트/소켓/소스 mount 없음 | 서버 2 CPU·1 GiB·heap 512 MiB, generator 1 CPU·512 MiB, swap 없음 |

Docker 환경은 개발자의 `.env`를 읽지 않고 Compose에 선언한 값만 컨테이너에 전달한다.
두 컨테이너는 비root·읽기 전용 root filesystem으로 실행하며 `/tmp`와 서버 DB volume만 쓴다.
SQLite JDBC의 native library 로딩을 위해 서버 `/tmp`만 executable tmpfs로 둔다.
이미지를 먼저 빌드한 뒤 컨테이너를 실행한다. 실패와 SIGINT/SIGTERM에서도 로그 수집과 정리를
시도하며 해당 실행의 project·volume·이미지 태그만 제거한다. 강제 종료나 daemon 장애로 정리가
불가능하면 `result.json`의 project로 남은 자원을 확인한다. 전역 prune은 하지 않는다.
새 결과 디렉터리만 허용한다. 재실행 시 다른 이름을 사용하며 실패한 증거를 덮어쓰지 않는다.

### 출력 단계와 중단 기준

`smoke`는 새 방·참가자 등록, WS 입장·제어 응답, 방 한도 거절 및 실제 격리를 확인한다.
`pilot`과 `output`은 방 1개·synthetic host 1개·터미널 1개·관전자 5명을 고정하고,
출력을 64 → 256 → 1,024 KiB/s로 올린다. 단계·반복마다 새 JVM과 DB를 사용한다.
`pilot`은 각 단계 3초 예열·5초 측정 1회이며 측정 도구 확인용이다.
`output`은 각 단계 30초 예열·60초 측정 3회다. 첫 실패 뒤 상위 단계와 다음 반복을 실행하지 않는다.

payload는 4 KiB의 반복 문자에 timestamp·sequence를 넣고 압축을 켠다. publisher와 관전자들은
하나의 generator 프로세스에서 같은 단조 시계를 사용한다. 결과에 계획/실제 payload byte,
관전자 수만큼의 수신 frame, 출력·제어 지연 histogram, 순서 오류·gap을 남긴다.
제어 probe는 존재하지 않는 터미널에 대한 응답이며 DB 쓰기 지연을 측정하지 않는다.
압축률이 높은 synthetic 출력이므로 실제 셸 출력·Connector·PTY·브라우저 성능과 구분한다.

호스트 watchdog이 부하와 독립적으로 약 1초마다 두 컨테이너를 직접 관측한다. 최초 양쪽 관측과
한도 확인이 통과해야 부하가 시작된다. 각 관측 명령은 2.5초로 제한하고, 관측 간격이 3초를
초과하거나 카운터가 초기화되면 실행을 무효로 판정한다. 부하 허용·성공 판정 직전에도 마지막 관측이
3초 이내인지 확인한다. 단계 전체에도 준비 시간을 포함한 deadline이 있다.

| 관측                                  | 판정                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| 컨테이너 memory.current               | 각 memory.max의 90% 이상이면 중단                                            |
| JVM RSS                               | 768 MiB 초과면 중단. heap·컨테이너 메모리와 별도                             |
| memory.events                         | oom 또는 oom_kill이 하나라도 있으면 중단                                     |
| CPU usage·nr_throttled·throttled_usec | 구간 차이와 quota 대비 사용률을 기록. throttling 단독으로 실패 처리하지 않음 |
| 출력                                  | 누락·추가 frame·순서 오류·gap 0, 전체 및 각 관전자 p95 ≤ 100 ms, 최대 ≤ 1초  |
| 제어                                  | p95 ≤ 250 ms, 최대 ≤ 1초, 미응답 probe 없음                                  |
| generator                             | schedule lag ≤ 250 ms, 송신 backlog ≤ 1 MiB, 계획한 payload 전량 송신        |
| 계측·프로세스                         | 명령 실패·누락된 값·프로세스 종료·단계 deadline 초과 시 중단                 |

메모리 사용량과 CPU counter의 의미는 [Linux cgroup v2 문서](https://docs.kernel.org/admin-guide/cgroup-v2.html)를 따른다.
CPU 사용률은 구간 CPU 시간 / (경과 시간 × quota CPU 수)이며, throttled period 비율과 throttled 시간은
별도로 기록한다. cgroup CPU quota는 전용 코어가 아니다. sampler 자체의 container exec 비용도 포함된다.
1초 관측이 급격한 OOM을 미리 막는다는 보장은 없으며 컨테이너 hard limit이 마지막 제한이다.

watchdog은 부하를 먼저 정지한 후 JFR·heap snapshot·로그를 수집한다. 성공 결과가 있어도 계측/정리
실패가 있으면 전체 성공으로 표시하지 않는다. JFR은 CPU·GC·heap·제어 큐 대기·buffer pressure를
최대 32 MiB로 기록하고 원본과 측정 구간 집계를 보관한다. 강제 GC는 하지 않는다.
서버가 이미 죽으면 JFR 추출은 실패할 수 있으며 원래의 중단 사유와 진단 실패를 함께 남긴다.
동작 중인 다른 컨테이너 목록도 기록하지만 종료하지 않는다. JFR/sampler overhead 보정은 아직 하지 않았다.

실행별 `manifest.json`, `stages.json`, `result.json`과 단계별 `samples.jsonl`, `load.json`,
`watchdog.json`, `load.jfr`, `flight.json`을 확인한다. 실패 시 생성하지 못한 파일은 없을 수 있다.
Docker Desktop의 tmpfs는 `docker cp`로 읽히지 않는 경우가 있어 실행 중인 컨테이너에서 직접 읽는다.
정상 완료 뒤 부하 컨테이너를 명시적으로 정지하므로 종료 code보다 `load.json`과 watchdog 판정을 확인한다.

기존 로컬 `full/recovery/admission/credentials`와 Docker `output`은 서로 다른 프로필이다.
Docker fan-out·다중 터미널·한도 거절·느린 소비자·동시 재접속·15분 지속 실험은 아직 연결하지 않았다.
모든 출력 단계가 통과해도 최대 용량을 발견했다는 의미는 아니다.
[측정 조건과 과거 결과](../docs/PERFORMANCE.md)를 참고한다.

## OS별 검증 범위

패키지 분리와 OS 지원은 별개다. 같은 계약을 OS별로 실행하고, 셸·프로세스 준비만 해당 환경에
맞춘다. 기대 결과를 OS별로 약화하거나 지원하지 않는 테스트를 skip한 뒤 지원 완료로 표시하지 않는다.

| 대상                           | 실행 환경                            | 현재 범위                                                                          |
| ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------- |
| Protocol·공유 프로세스 fixture | Linux / macOS / Windows runner       | `portable-contracts` CI matrix. 네이티브 PTY·Java는 포함하지 않음                  |
| Spring HTTP/WS/SQLite          | Linux Java 21 CI, 로컬 macOS Java 21 | 기존 프로세스 계약                                                                 |
| 격리 서버·generator            | Linux 컨테이너                       | 격리 smoke 및 synthetic 출력 단계. 호스트가 Mac이어도 Linux 결과                   |
| Connector·PTY                  | macOS 및 Linux의 POSIX 셸            | 기존 로컬/CI 통합 검증                                                             |
| Connector·PTY                  | Windows                              | 미지원/미검증. 기본 `/bin/sh`, POSIX 명령·종료 의미, 메타데이터 수집부터 대응 필요 |
| 브라우저 협업                  | Chromium + POSIX Connector           | 기존 테스트는 `/bin/zsh` 전제. Windows·Firefox·WebKit 검증으로 확대하지 않음       |

OS별 성능 비교는 CPU 아키텍처·자원 제한·JVM·부하·압축·계측 옵션을 함께 기록한다.
GitHub hosted runner 수치로 OS 성능 우열을 판단하지 않는다. Docker VM도 호스트의 다른 프로세스와
자원을 공유하므로 패키지와 컨테이너 분리만으로 성능 간섭이 사라지지는 않는다.
