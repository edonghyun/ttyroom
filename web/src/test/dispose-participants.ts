export interface DisposableParticipant {
  assertHealthy(): void;
  dispose(): Promise<void>;
}

export async function disposeParticipants(
  participants: Iterable<DisposableParticipant>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const participant of participants) {
    try {
      participant.assertHealthy();
    } catch (error) {
      failures.push(error);
    }
    try {
      await participant.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
