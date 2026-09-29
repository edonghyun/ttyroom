# 독립 디렉터리 구조 정리

> `artifacts/` 경로는 로컬 보관 자료이며 공개 저장소에는 포함하지 않습니다. 수치와 명령은 작성 당시의 검증 기록입니다.

Git 저장소는 하나로 유지하며 서브모듈을 도입하지 않았다. Java는 Gradle, TypeScript는 pnpm workspace로 관리한다.

| 이전 경로          | 현재 경로          |
| ------------------ | ------------------ |
| packages/web       | web                |
| packages/connector | connector          |
| packages/protocol  | protocol           |
| packages/e2e       | e2e                |
| packages/server    | legacy/node-server |
| backend            | backend (유지)     |

패키지 이름과 공개 명령·프로토콜은 유지한다. workspace와 lockfile의 연결 경로, TypeScript 설정, E2E 실행 파일 경로, 브라우저 fixture, 정적 파일 복사, 의존성 규칙, CI 증거 경로를 갱신했다. 과거 기록·artifacts 내부 경로는 당시 증거이므로 변경하지 않았다.

루트 README가 현재 실행 방법의 기준이다. 기존 Node 서버는 여전히 완전한 협업 구현이며 Spring은 P3a까지 구현된 상태다.

## 로컬 검증

- frozen lockfile 설치, 전체 TypeScript 빌드·타입 검사 통과
- 단위 534개, 통합 36개, 프로세스 E2E 25개, 브라우저 30개 통과
- 변경 범위 포맷 검사와 의존성 규칙 검사 통과
- 새 e2e 경로에서 Java JAR 시작·재시작 smoke 통과

원격 CI는 아직 실행하지 않았다. 실행 로그는 `artifacts/migration-baseline/layout-2026-09-19/`에 보관한다.
