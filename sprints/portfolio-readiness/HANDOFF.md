# 현재 작업

## 마지막 완료

[T8.1 — 공개 CI 검증](https://github.com/edonghyun/ttyroom/issues/1)

- 검증 소스: `8a5a0b894ba47a4b740a2f07c3df9db0117cfdf1`.
- [실행](https://github.com/edonghyun/ttyroom/actions/runs/36565833540): 6개 작업 모두 성공.
- TypeScript 544개, 통합 37개, Node 프로토콜 213개, Spring 프로토콜 205개와 별도 정적 웹 8개, 브라우저 각각 38개 통과. Java test·bootJar 성공.
- [검증 기록](../../docs/VERIFICATION.md)에 환경·중복 집계 제외·실패 수정·한계를 연결했다.
- 빌드 순서와 테스트용 셸 설정, 문서 링크를 리뷰했다. 이번 스프린트 등록에서는 런타임 코드를 바꾸지 않았다.

## 마지막 완료 — T8.2

[T8.2 — 실제 협업 시연](https://github.com/edonghyun/ttyroom/issues/2)

- [89초 영상과 재현 절차](../../docs/demo/README.md): Spring·실제 Connector·PTY·두 브라우저의 입장, 출력, 제어권 전환, 연결 복구.
- 녹화 시나리오 1개 통과, 전체 디코딩·Chromium 재생·9개 시점의 가독성/노출 확인 완료.
- 녹화 환경 수정과 실패 시 정리·이전 결과 오사용 방지를 독립 리뷰로 점검했다.
- 첨부된 과거 CI 실패 알림도 병렬 점검했다. 최신 런타임 기준 ae395b2와 직전 8a5a0b8 모두 6개 작업 성공. [실패→수정 매핑](../../docs/VERIFICATION.md) 참조.

## 다음 작업

[T8.3 — 대표 설계 설명](https://github.com/edonghyun/ttyroom/issues/3)

아직 착수하지 않았다. 저장 직렬화, 저장 후 전달 실패, 재접속 복구를 문제 → 선택 → 대안·비용 → 코드·테스트 근거 순서로 다듬는다.

## 이후

T8.3 완료 뒤 스프린트 1 회고. 인증 완성은 별도 후속 백로그이며 이 스프린트의 완료 조건에 포함하지 않는다.
