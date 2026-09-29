# Node server — migration reference

현재 협업 기능을 제공하는 기존 Node.js/TypeScript 서버다. Spring 대체 구현은 저장소 루트의 `backend/`에 있다.

전환 기간에는 이 서버를 공통 E2E의 기준 구현으로 유지한다. 아직 폐기되거나 Spring으로 대체된 상태가 아니다. 프로토콜·저장 호환 및 기능 검증이 끝난 뒤 기본 실행 대상을 전환한다.

저장소 루트에서:

```sh
pnpm --filter @ttyroom/server build
TTYROOM_PORT=3000 pnpm --filter @ttyroom/server exec node dist/index.js
```

[전체 실행 안내](../../README.md) · [전환 계획](../../docs/2026-09-18-connector-spring-boot-plan.md)
