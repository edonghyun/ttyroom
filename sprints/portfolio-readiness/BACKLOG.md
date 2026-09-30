# Backlog

[Sprint 1](https://github.com/edonghyun/ttyroom/milestone/1)의 범위는 T8.1–T8.3이다. 나머지는 후속·선택 백로그이며 현재 스프린트의 완료 조건에 포함하지 않는다.

실시간 진행 상태와 세부 완료 기준은 연결된 GitHub issue에서 확인한다. 아래 순서로 한 작업씩 처리한다.

| 작업                                                    | 내용                                                | 선행 작업 | 범위             |
| ------------------------------------------------------- | --------------------------------------------------- | --------- | ---------------- |
| [T8.1](https://github.com/edonghyun/ttyroom/issues/1)   | 현재 소스의 공개 CI 검증을 완료하고 근거 연결       | 없음      | Sprint 1         |
| [T8.2](https://github.com/edonghyun/ttyroom/issues/2)   | 실제 협업 흐름을 1~2분 시연으로 제작                | T8.1      | Sprint 1         |
| [T8.3](https://github.com/edonghyun/ttyroom/issues/3)   | 대표 설계 세 가지를 면접 설명으로 다듬기            | T8.1      | Sprint 1         |
| [T8.4](https://github.com/edonghyun/ttyroom/issues/4)   | 공개 배포 라이선스와 출처 확인                      | 없음      | 소유자 선택 필요 |
| [T9.1](https://github.com/edonghyun/ttyroom/issues/5)   | credential 발급·취소를 원자적 저장 경계에 연결      | T8.1      | 후속 인증        |
| [T9.2](https://github.com/edonghyun/ttyroom/issues/6)   | 관리자·참가자·host 등록 API의 권한 경계 구현        | T9.1      | 후속 인증        |
| [T9.3](https://github.com/edonghyun/ttyroom/issues/7)   | v8 입장과 동일 주체 연결 교체 계약 구현             | T9.2      | 후속 인증        |
| [T9.4](https://github.com/edonghyun/ttyroom/issues/8)   | React와 Connector를 주체별 credential 입장으로 전환 | T9.3      | 후속 인증        |
| [T9.5](https://github.com/edonghyun/ttyroom/issues/9)   | credential 취소와 입장 경합을 E2E로 마감            | T9.4      | 후속 인증        |
| [T10.1](https://github.com/edonghyun/ttyroom/issues/10) | 재현 가능한 지연·메모리 측정 기준 마련              | 없음      | 선택             |
| [T11.1](https://github.com/edonghyun/ttyroom/issues/11) | API 명세 자동 검증과 문서 UI 필요성 검토            | T9.5      | 선택             |

## 범위 경계

- T9.1–T9.5의 저장·등록·v8 입장·클라이언트 연동·취소를 구현했다. 최종 로컬 검증은 Java 455개, 인증·취소 프로세스 15개, 등록 4개, 브라우저 42개다. 공개 CI와 완료 상태는 T9.5 issue를 기준으로 확인한다.
- T9.3–T9.4는 서버와 클라이언트의 호환성을 함께 다룬다. 중간 구현을 사용 가능한 전환 완료로 표시하지 않는다.
- 라이선스는 소유자가 조건을 선택한 뒤 반영한다. 다른 작업을 기다리게 하는 선행 조건으로 두지 않는다.
- 성능 측정과 문서 UI는 필요성과 측정 기준을 확인한 뒤 착수한다.
