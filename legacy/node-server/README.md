# Node 서버 참조 구현

초기 개발 과정에서 작성한 Node.js/TypeScript 서버다. 현재 기본 서버는
[Spring Boot 백엔드](../../backend/README.md)이며, 이 디렉터리는 공통 프로토콜의
회귀 비교와 개발 이력 확인에 사용한다. 사용자 PC에서 실행하는 Node Connector와는 별개다.

현재 pnpm의 `test:e2e`·`test:browser` 기본 대상은 이 서버다.
Spring을 검증할 때는 `scripts/test-spring.sh protocol|browser`를 사용한다.
두 구현의 모든 내부 실패 처리나 설정 기본값이 같다는 뜻은 아니다.

저장소 루트에서 의존성 설치와 protocol 빌드 후 실행한다.

```sh
pnpm --filter @ttyroom/protocol build
pnpm --filter @ttyroom/server build
TTYROOM_PORT=3001 pnpm --filter @ttyroom/server exec node dist/index.js
```

[현재 실행 안내](../../README.md) · [테스트 실행 경계](../../e2e/README.md)
