# README 화면과 도식

2026-09-28 로컬 Chromium에서 웹 포함 Spring JAR, 실제 Connector와 PTY로 캡처했다.
Alice와 Bob은 별도 브라우저 context로 같은 방에 입장했다. viewport는 각각 1100×760이다.
합성 화면이나 샘플 출력을 삽입하지 않았다. 화면의 Browser Acceptance와 real-host는
기존 E2E fixture의 방·컴퓨터 이름이다. 셸 프롬프트는 로컬 실행 환경을 반영한다.

- [Alice 원본](collaboration-alice.png): 제어권 보유, Bob의 커서와 공유 출력.
- [Bob 원본](collaboration-bob.png): 관찰 전용 상태, Alice의 커서와 같은 출력.
- [시스템 구성 렌더링](architecture-system.png)
- [상태 변경 시퀀스 렌더링](architecture-sequence.png)

캡처는 실제 출력 수신과 두 참여자의 권한 상태를 기다린 뒤 수행했다. 일회성
캡처 코드 (로컬 `artifacts/readme-capture/readme-capture.e2e.ts`)는 실행 당시
`web/e2e/readme-capture.e2e.ts` 위치를 기준으로 한다. 다시 실행하려면 해당 위치로 복사하고
`./scripts/test-spring.sh browser e2e/readme-capture.e2e.ts`를 실행한 뒤 임시 파일을 제거한다.
일반 회귀 테스트 목록에는 포함하지 않는다. 이번 캡처 실행 1개가 통과했으며 전체 E2E 재실행은 아니다.

도식은 README와 docs/ARCHITECTURE.md의 Mermaid 원문을 로컬 Mermaid와 Chromium으로
렌더링하고 이미지로 확인했다. GitHub의 Mermaid 버전·폰트에 따라 배치는 달라질 수 있다.
원문을 수정하면 여기의 렌더링 이미지도 다시 생성해야 한다.
