# Spring 정적 웹 제공과 브라우저 E2E — P4f

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

2026-09-28. Spring 실행 JAR에 React 빌드 결과를 선택적으로 포함하고, 실제 Chromium·Connector·PTY를
사용하는 기존 브라우저 테스트를 Node와 Spring 양쪽에서 실행하도록 연결했다. 테스트 실행 시 서버
내부 함수를 import하지 않고 HTTP/WebSocket과 별도 서버 프로세스를 사용한다.

## 빌드·실행

Java 21 환경에서 저장소 루트 기준으로 실행한다.

```sh
pnpm install --frozen-lockfile
pnpm --filter @ttyroom/web build
./backend/gradlew -p backend test bootJar -PwebDist=../web/dist
TTYROOM_STATE_PATH=.ttyroom/rooms.sqlite java -jar backend/build/libs/ttyroom-backend.jar
```

이제 `http://127.0.0.1:3000`에서 방을 만들고 기존 Connector로 연결할 수 있다.
`webDist` 경로는 Gradle 프로젝트인 backend 기준이다. 옵션을 생략한 빌드와 bootRun은 웹을 묶지 않는
API 서버다. Java 테스트·API 빌드는 계속 Node 없이 가능하다. 프런트 빌드는 명시적으로 pnpm에서 수행한다.

웹은 processResources의 공유 출력에 복사하지 않고 bootJar에 직접 포함한다. 웹 포함 빌드 다음에
API-only 빌드를 해도 이전 웹 파일이 남지 않는지 JAR 내용을 검사했다. 명시한 webDist에 index.html이
없으면 빌드가 실패한다. 최종 JAR에는 실제 웹 파일 22개가 있고 테스트용 HTML/JS는 포함하지 않는다.

## HTTP 책임

`StaticWebController`가 classpath의 `web/` 안에서 `/`, `/r/{roomId}`와 평평한 `/assets/{name}`만 제공한다.
API·health·WS 경로를 SPA fallback으로 처리하지 않는다. 자산 이름과 MIME 확장자를 제한하고,
Spring의 기본 정적 리소스 mapping은 비활성화한다. 요청별 별도 서비스나 저장소 포트는 추가하지 않았다.

HTML은 no-store, 빌드 자산은 1년 immutable cache이며 GET/HEAD를 지원한다. CSP·COOP·Referrer-Policy·
nosniff는 Node의 기존 정책을 유지한다. Content-Type의 세미콜론 뒤 공백은 Spring이 정규화하므로
테스트는 MIME 의미를 비교한다. 미지원 HTTP 메서드와 일반 미매핑 경로는 Spring의 오류 처리를 따른다.

## 테스트 구조

- `e2e/src/`: 실제 서버 프로세스와 프로토콜 peer 또는 실제 Connector로 검사한다. 기존 단계의
  183개는 이 계층이다. 이번에 배포 HTML/실제 해시 자산/HEAD/404 계약 8개를 추가했다.
- `web/e2e/`: 실제 Chromium에서 참가자별 독립 context로 화면을 조작한다. 제어권·입력·출력·창 배치·
  재접속·키보드·접근성·Kill Switch·Room Gone을 검증한다. 기존 30개에 영속 재시작 1개를 추가했다.
- Browser TestSystem은 공통 ServerProcess를 사용한다. `TTYROOM_E2E_SERVER_COMMAND`만 교체하며,
  같은 fixture·화면 action·assertion을 두 서버에서 실행한다. 서버별 조건문이나 기대값 분기는 없다.
- `restartWithoutRooms()`는 서버를 같은 주소에서 새 SQLite 파일로 시작하는 명시적 테스트 장애다.
  일반 restart는 저장 파일을 유지한다. 기존 Node의 메모리-only fixture를 프로세스 경계로 이동하면서
  두 행동을 분리했다. 임시 파일은 ServerProcess가 마지막에 모두 정리한다.
- 출력 gap 브라우저 사례는 Node의 살아 있는 policy 객체를 수정하던 의존성을 제거했다.
  `OutputGapFault`가 실제 서버 연결의 한 출력 frame을 수신 경계에서 가리고 output-gap을 주입한다.
  잠시 수신을 멈춰 Restoring을 관찰한 뒤, **실제 서버가 응답한 replay**를 전달한다. 서버 드롭 정책
  전체를 이 테스트만으로 입증하는 것은 아니다. 그 정책은 기존 Java/공통 정책 E2E가 담당한다.
- 새 영속 재시작 사례는 shell 환경변수와 창 배치를 준비한 후 새 서버에서 다시 제어권을 얻어 출력·
  geometry를 확인한다. 입력 문자열 자체의 echo로 성공하지 않도록 기대 출력 문자열을 분리했다.

```sh
# Node 비교 구현
pnpm --filter @ttyroom/server build
pnpm --filter @ttyroom/connector build
pnpm test:browser

# Spring — 위의 웹 포함 JAR를 먼저 빌드. JAR는 절대 경로로 지정한다.
TTYROOM_E2E_SERVER_COMMAND='["java","-jar","/absolute/path/to/backend/build/libs/ttyroom-backend.jar"]' \
  pnpm test:browser
```

Playwright Chromium 설치가 필요하다: `pnpm --filter @ttyroom/web exec playwright install chromium`.
CI는 Node/Spring matrix로 같은 테스트를 실행한다. 기존 키보드 사례가 zsh의 read 동작을 사용하므로
CI의 Connector shell을 zsh로 고정했다. 테스트가 하나도 선택되지 않아도 성공하던 옵션도 제거했다.

## 실제 RED와 수정 기록

1. Java 정적 웹 테스트 10개 중 루트·초대 HTML·JS·HEAD 4개가 404라서 실패했다. 구현 후에는 200이
   되었지만 최초 기대값에 MIME 공백과 수동 계산한 길이 오류가 있었다. MIME 비교와 실제 기대 문자열의
   UTF-8 길이로 고쳤다. 이 중간 실패를 production 결함 수정처럼 표현하지 않는다.
2. fixture 변경 전 Node 브라우저 30개가 통과했다. 변경 후 Node는 신규 재시작을 포함해 31개 통과했다.
3. 첫 Spring 브라우저 실행은 29개 통과, 재시작 2개가 teardown에서 실패했다. 화면의 복구/Room Gone
   assertion은 통과했지만 실제 프로세스 downtime의 ERR_CONNECTION_REFUSED가 수집됐다.
4. 명시적 재시작 시나리오에서 **해당 서버 WS 주소의 연결 거절 오류만** 허용했다. 페이지 예외나
   다른 콘솔 오류는 계속 실패한다. 두 재시작 사례의 재실행이 통과했다. 실패 screenshot·trace는 보존했다.

정적 파일 기능은 실제 RED→GREEN이며 브라우저 실행 경계 변경은 기존 GREEN을 기준으로 한 리팩터링이다.
새 영속 재시작은 이미 구현된 기능의 인수 검증 추가다. 각각의 검증 의미를 섞지 않는다.

## 검증 근거와 한계

로그·최초 실패 trace·빌드 검사·최종 hash는 `artifacts/migration-baseline/p4f-browser-web/`에 둔다.
Java 전체 353개가 실패·오류·건너뜀 없이 통과했다. 브라우저는 Chromium Desktop 대상이며 Safari·Firefox·
모바일 시각 회귀나 운영 배포까지 검증한 것은 아니다. 재시작 실행기의 250ms 종료 제한 때문에
프로세스 복구와 graceful shutdown 보장도 구별한다. 원격 CI 결과는 로컬 테스트 결과와 별개다.

최종 실행 결과:

- Java 전체 **353개** 통과.
- Chromium 브라우저 **Node 31개 / Spring 31개** 통과. 선택 제외 없이 동일한 31개다.
- 관련 Spring 프로세스 E2E **72개 / 6개 파일** 통과: static web·HTTP·입장·host·영속 복구·실행기 수명.
  이전 단계의 전체 183개를 이번에 모두 재실행한 수치가 아니다.
- Node static web·실행기 수명 **13개**, 브라우저 CI 빌드 계약 **1개** 통과.
- web/e2e 타입·포맷·의존성 검사와 API-only→누락 경로 실패→웹 포함 JAR 검사 통과.
- CI 정의는 갱신했으며 원격 CI 실행 성공을 주장하지 않는다.
