# 현재 작업

## 완료 — T8.1

[T8.1 — 공개 CI 검증](https://github.com/edonghyun/ttyroom/issues/1)

- 검증 소스: `8a5a0b894ba47a4b740a2f07c3df9db0117cfdf1`.
- [실행](https://github.com/edonghyun/ttyroom/actions/runs/36565833540): 6개 작업 모두 성공.
- TypeScript 544개, 통합 37개, Node 프로토콜 213개, Spring 프로토콜 205개와 별도 정적 웹 8개, 브라우저 각각 38개 통과. Java test·bootJar 성공.
- [검증 기록](../../docs/VERIFICATION.md)에 환경·중복 집계 제외·실패 수정·한계를 연결했다.
- 빌드 순서와 테스트용 셸 설정, 문서 링크를 리뷰했다. 이번 스프린트 등록에서는 런타임 코드를 바꾸지 않았다.

## 완료 — T8.2

[T8.2 — 실제 협업 시연](https://github.com/edonghyun/ttyroom/issues/2)

- [89초 영상과 재현 절차](../../docs/demo/README.md): Spring·실제 Connector·PTY·두 브라우저의 입장, 출력, 제어권 전환, 연결 복구.
- 녹화 시나리오 1개 통과, 전체 디코딩·Chromium 재생·9개 시점의 가독성/노출 확인 완료.
- 녹화 환경 수정과 실패 시 정리·이전 결과 오사용 방지를 독립 리뷰로 점검했다.
- 첨부된 과거 CI 실패 알림도 병렬 점검했다. 최신 런타임 기준 ae395b2와 직전 8a5a0b8 모두 6개 작업 성공. [실패→수정 매핑](../../docs/VERIFICATION.md) 참조.

## 마지막 완료 — T8.3

[T8.3 — 대표 설계 설명](https://github.com/edonghyun/ttyroom/issues/3)

- [PORTFOLIO](../../docs/PORTFOLIO.md)에 저장 직렬화·저장 후 전달 실패·재접속 복구를 문제 → 선택 → 대안·비용 → 코드·테스트로 정리했다.
- 각 사례에 90초 연습 원고와 후속 질문을 붙였다. 발화 시간을 측정한 것은 아니다.
- Node의 Promise queue/송신 경계와 Spring의 lock/PeerUnavailable 처리를 비교했다. 공통 E2E가 내부 실패 처리까지 같다는 의미는 아니다.
- 특성 테스트와 실제 RED → GREEN 기록, 출력 replay와 입력 exactly-once, 브라우저 재접속과 서버 재시작을 구분했다.
- [이번 검증 범위](../../docs/VERIFICATION.md#2026-09-29-대표-설계-설명-t83): Java 저장 테스트 35개, Node/Spring의 복구·영속성 프로토콜 계약 각각 14개. 운영 코드와 테스트 동작은 변경하지 않았다.

## Sprint 1 회고

- 공개 CI, 실제 협업 시연, 설명과 코드·테스트의 연결이라는 T8.1–T8.3 범위를 마쳤다.
- 첫 공개 CI가 로컬 산출물 의존과 개인 셸 설정 의존을 드러냈다. 새 환경 검증과 테스트 실행 환경의 소유권을 유지한다.
- 문서는 구현과 차이를 계속 대조해야 한다. 특히 Spring의 전송 실패 계약을 Node에도 있다고 설명하거나 출력 중복 제거를 입력 실행 보장으로 확대하지 않는다.

## 다음 작업

[T9.1 — credential 원자적 저장](https://github.com/edonghyun/ttyroom/issues/5)을 후속 스프린트의 첫 구현 후보로 둔다.
아직 착수하지 않았다. 기존 credential 모델의 발급·취소를 저장 실패 비노출 경계에 연결하는 계약부터 고정한다.
인증 완성은 T9.5까지 서버·클라이언트·취소 경합 검증을 마친 뒤 판단한다.

[T8.4 — 라이선스](https://github.com/edonghyun/ttyroom/issues/4)는 소유자 선택을 기다리는 별도 백로그로 유지한다.
