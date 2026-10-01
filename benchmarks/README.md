# Benchmarks

`@ttyroom/benchmarks`는 부하 생성, JVM 관측, 결과 분석과 격리 환경을 소유한다.
`e2e`는 HTTP/WS 기능 계약을 검증하고, `test-support`는 양쪽과 브라우저 테스트가 사용하는
서버 프로세스·소켓·자원 정리 도구를 제공한다. 서버 내부 구현은 import하지 않는다.

| 위치                         | 책임                                      |
| ---------------------------- | ----------------------------------------- |
| `benchmarks/src/*-run.ts`    | 명시적으로 실행하는 측정 시나리오         |
| `benchmarks/src/*-report.ts` | 관측값 집계·성공/실패 판정                |
| `benchmarks/src/*.spec.ts`   | 계측 코드의 빠른 회귀 테스트              |
| `benchmarks/docker/`         | Linux 격리 smoke 환경                     |
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
```

Docker 실행은 Docker Desktop/Engine과 Linux cgroup v2가 필요하다. 최초 실행은 Java 21 및
Node 22 이미지를 다운로드한다. 이미지 ID·아키텍처·실제 자원 설정과 불변 JAR hash를 기록한다.

| 환경              | 설정·데이터·네트워크                                                              | 자원                                                              |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 개발              | 개발자가 선택한 설정과 `.ttyroom`                                                 | 호스트 자원                                                       |
| 기능 E2E          | 실행별 임시 설정/SQLite, 임의 localhost 포트                                      | 호스트 자원                                                       |
| 로컬 JVM 벤치마크 | 실행별 임시 SQLite, 새 결과 디렉터리, 복사한 JAR                                  | 고정 JVM 옵션, 호스트 CPU 공유                                    |
| Docker smoke      | 고유 Compose project·내부 네트워크·새 DB volume, 호스트 포트/소켓/소스 mount 없음 | 서버 2 CPU·1 GiB·heap 512 MiB, generator 1 CPU·512 MiB, swap 없음 |

Docker 환경은 개발자의 `.env`를 읽지 않고 Compose에 선언한 값만 컨테이너에 전달한다.
두 컨테이너는 비root·읽기 전용 root filesystem으로 실행하며 `/tmp`와 서버 DB volume만 쓴다.
SQLite JDBC의 native library 로딩을 위해 서버 `/tmp`만 executable tmpfs로 둔다.
이미지를 먼저 빌드한 뒤 컨테이너를 실행한다. 실패와 SIGINT/SIGTERM에서도 로그 수집과 정리를
시도하며 해당 실행의 project·volume·이미지 태그만 제거한다. 강제 종료나 daemon 장애로 정리가
불가능하면 `result.json`의 project로 남은 자원을 확인한다. 전역 prune은 하지 않는다.
새 결과 디렉터리만 허용한다. 재실행 시 다른 이름을 사용하며 실패한 증거를 덮어쓰지 않는다.

현재 Docker smoke는 새 방·참가자 등록, WS 입장·제어 응답, 방 한도 거절 및 실제 cgroup 설정을
확인한다. 기존 `smoke/full/recovery/admission/credentials` 부하 프로필은 아직 로컬 JVM용이다.
컨테이너용 연속 관측·중단 watchdog·부하 프로필 연결은 후속 단계이며, smoke 성공을 용량 검증으로
표시하지 않는다. [측정 조건과 과거 결과](../docs/PERFORMANCE.md)를 참고한다.

## OS별 검증 범위

패키지 분리와 OS 지원은 별개다. 같은 계약을 OS별로 실행하고, 셸·프로세스 준비만 해당 환경에
맞춘다. 기대 결과를 OS별로 약화하거나 지원하지 않는 테스트를 skip한 뒤 지원 완료로 표시하지 않는다.

| 대상                           | 실행 환경                            | 현재 범위                                                                          |
| ------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------- |
| Protocol·공유 프로세스 fixture | Linux / macOS / Windows runner       | `portable-contracts` CI matrix. 네이티브 PTY·Java는 포함하지 않음                  |
| Spring HTTP/WS/SQLite          | Linux Java 21 CI, 로컬 macOS Java 21 | 기존 프로세스 계약                                                                 |
| 격리 서버·generator            | Linux 컨테이너                       | smoke. 호스트가 Mac이어도 Linux 결과                                               |
| Connector·PTY                  | macOS 및 Linux의 POSIX 셸            | 기존 로컬/CI 통합 검증                                                             |
| Connector·PTY                  | Windows                              | 미지원/미검증. 기본 `/bin/sh`, POSIX 명령·종료 의미, 메타데이터 수집부터 대응 필요 |
| 브라우저 협업                  | Chromium + POSIX Connector           | 기존 테스트는 `/bin/zsh` 전제. Windows·Firefox·WebKit 검증으로 확대하지 않음       |

OS별 성능 비교는 CPU 아키텍처·자원 제한·JVM·부하·압축·계측 옵션을 함께 기록한다.
GitHub hosted runner 수치로 OS 성능 우열을 판단하지 않는다. Docker VM도 호스트의 다른 프로세스와
자원을 공유하므로 패키지와 컨테이너 분리만으로 성능 간섭이 사라지지는 않는다.
