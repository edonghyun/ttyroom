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

## 완료 — T8.3

[T8.3 — 대표 설계 설명](https://github.com/edonghyun/ttyroom/issues/3)

- [PORTFOLIO](../../docs/PORTFOLIO.md)에 저장 직렬화·저장 후 전달 실패·재접속 복구를 문제 → 선택 → 대안·비용 → 코드·테스트로 정리했다.
- 각 사례에 90초 연습 원고와 후속 질문을 붙였다. 발화 시간을 측정한 것은 아니다.
- 현재 서버의 명령 순서와 수신자별 실패 처리 경계를 실제 코드·테스트로 확인했다.
- 특성 테스트와 실제 RED → GREEN 기록, 출력 replay와 입력 exactly-once, 브라우저 재접속과 서버 재시작을 구분했다.
- [이번 검증 범위](../../docs/VERIFICATION.md#2026-09-29-대표-설계-설명-t83): Java 저장 테스트 35개, Node/Spring의 복구·영속성 프로토콜 계약 각각 14개. 운영 코드와 테스트 동작은 변경하지 않았다.

## 문서 소개 기준

- 프로젝트는 직접 설계·개발한 협업 터미널로 소개한다. 핵심 설명은 방 상태·입력 제어·실패 처리·재접속 복구다.
- 언어 변경과 구현 비교는 개발 이력으로 둔다. 대표 설명과 현재 백엔드 안내에 단계별 진행 기록을 섞지 않는다.
- [포트폴리오](../../docs/PORTFOLIO.md), [현재 백엔드 설계](../../backend/ARCHITECTURE.md), [개발 이력 안내](../../docs/README.md#개발-이력)를 연결했다.
- 실행 결과와 소스 SHA는 기존 검증 기록 그대로 유지한다. 이번 문서 정리는 새로운 제품 동작이나 테스트 실행 성과가 아니다.

## Sprint 1 회고

- 공개 CI, 실제 협업 시연, 설명과 코드·테스트의 연결이라는 T8.1–T8.3 범위를 마쳤다.
- 첫 공개 CI가 로컬 산출물 의존과 개인 셸 설정 의존을 드러냈다. 새 환경 검증과 테스트 실행 환경의 소유권을 유지한다.
- 문서는 현재 구현과 계속 대조한다. 출력 중복 제거를 입력 실행 보장으로 확대하지 않는다.

## 마지막 완료 — T9.1

[T9.1 — credential 원자적 저장](https://github.com/edonghyun/ttyroom/issues/5)

- 방별 명령 순서에서 credential draft를 저장한 뒤 확정한다. 실패 시 성공 응답·인증 상태를 노출하지 않는다.
- SQLite 파일 재열기 후 발급·선택 취소를 복원하고 일반 방 상태 저장에서도 credential을 보존한다.
- 비밀값 대신 digest만 저장한다. 중복·손상된 credential 레코드를 거절하며 v1/v2 저장 표현을 구분한다.
- 실패 테스트와 후속 구현·리뷰 과정은 [T9.1 기록](../../docs/2026-09-29-identity-design.md#t91-발급취소의-저장과-복원)에 있다.
- Java 전체 380개 통과. 프로세스 검증과 실행 범위는 [검증 기록](../../docs/VERIFICATION.md)을 따른다.
- v7 입장 정책·관리 권한·현재 연결 종료는 변경하지 않았다. 인증 보완 전체의 완료는 아니다.

## 다음 작업

[T9.2 — 등록 API 권한 경계](https://github.com/edonghyun/ttyroom/issues/6).
관리 credential의 발급·저장·검증과 참가자/host 등록을 구현한다. 아직 착수하지 않았다.
인증 완성은 T9.5까지 서버·클라이언트·취소 경합 검증을 마친 뒤 판단한다.

[T8.4 — 라이선스](https://github.com/edonghyun/ttyroom/issues/4)는 소유자 선택을 기다리는 별도 백로그로 유지한다.
