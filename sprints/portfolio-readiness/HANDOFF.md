# 현재 작업

## 마지막 완료

[T8.1 — 공개 CI 검증](https://github.com/edonghyun/ttyroom/issues/1)

- 검증 소스: `8a5a0b894ba47a4b740a2f07c3df9db0117cfdf1`.
- [실행](https://github.com/edonghyun/ttyroom/actions/runs/36565833540): 6개 작업 모두 성공.
- TypeScript 544개, 통합 37개, Node 프로토콜 213개, Spring 프로토콜 205개와 별도 정적 웹 8개, 브라우저 각각 38개 통과. Java test·bootJar 성공.
- [검증 기록](../../docs/VERIFICATION.md)에 환경·중복 집계 제외·실패 수정·한계를 연결했다.
- 빌드 순서와 테스트용 셸 설정, 문서 링크를 리뷰했다. 이번 스프린트 등록에서는 런타임 코드를 바꾸지 않았다.

## 다음 작업

[T8.2 — 협업 시연](https://github.com/edonghyun/ttyroom/issues/2)

아직 착수하지 않았다. 1~2분 시연 시나리오와 전용 실행 환경을 준비하고, 실제 Spring·Connector·PTY·두 브라우저로 녹화한다.
비밀값·개인 경로 노출 여부를 확인하고 영상을 재생 검토한 뒤 README에 연결한다.

## 이후

T8.3 대표 설계 설명 → 스프린트 1 회고. 인증 완성은 별도 후속 백로그이며 이 스프린트의 완료 조건에 포함하지 않는다.
