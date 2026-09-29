# RoomAppRuntime 수명주기 검토

## 수정한 경계

아직 join하지 않은 런타임을 dispose한 뒤 join을 호출하면 기존 구현은 새 세션을
생성·시작하고 닉네임을 저장했다. 이미 disposed인 런타임은 이후 dispose 호출을
무시하므로 이렇게 시작한 세션은 런타임의 정상 종료 경로로 정리되지 않는다.

런타임 API 호출 순서로 재현했으며, 실제 브라우저에서 발생한 사고를 관측한 것은 아니다.
join의 기존 route/session 검사에 disposed 검사를 추가해 종료 상태에서 세션 생성을 막았다.
새 상태나 별도 lifecycle 객체는 추가하지 않았다.

## 테스트

- RED: dispose 후 join이 세션과 닉네임 저장을 시작하지 않아야 한다는 새 테스트 실패.
  당시 해당 파일은 12개 통과, 1개 실패였다.
- GREEN: 종료 상태 검사 추가 후 프론트엔드 전체 175개 테스트 통과.
- 별도 특성 테스트로 dispose 두 번 후 session stop, 구독 해제, controller dispose가
  한 번만 실행됨을 확인했다. 이후 실제 projection/window 변경이 발생해도 런타임 view,
  controller 생성 수, session focus 호출 수는 변하지 않는다.
- TypeScript typecheck와 변경 파일 포맷 검사 통과.

## 유지한 설계와 범위

기존 geometry 테스트는 welcome/event 반영, 로컬 move/resize 전송, 무관한 output으로
로컬 위치가 되돌아가지 않는 계약을 검증한다. WindowManager 테스트는 최소화 복원과
geometry 보존을 검증한다. 이번 전체 단위 테스트 실행에 모두 포함했다.

dispose는 projection/window/viewport/session 구독 해제와 toast timer 취소를 소유한다.
이미 확인한 정리 책임을 여러 객체로 나누지 않았다. 모든 비정상 구현의 늦은 callback이나
dispose 이후 모든 공개 메서드 호출을 차단하는 변경은 이번 범위가 아니다.

브라우저 E2E와 Java 테스트는 이번 단계에서 재실행하지 않았다.
