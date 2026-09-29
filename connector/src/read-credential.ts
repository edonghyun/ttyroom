import type { ReadStream } from "node:tty";

/** Reads a single secret line without terminal echo; restores input before the kill-switch owns it. */
export function readCredential(input: ReadStream, prompt: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    const tty = input.isTTY;
    const cleanup = () => {
      input.off("data", receive);
      input.off("end", ended);
      input.off("error", failed);
      if (tty) input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const finish = () => {
      cleanup();
      if (/^[A-Za-z0-9_-]{32}$/.test(value)) resolve(value);
      else reject(new Error("Host credential must be a 32-character registration credential"));
    };
    const ended = () => finish();
    const failed = () => {
      cleanup();
      reject(new Error("Could not read host credential"));
    };
    const receive = (bytes: Buffer) => {
      for (const byte of bytes) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Credential input cancelled"));
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        if (value.length >= 32 || byte < 32 || byte > 126) {
          failed();
          return;
        }
        value += String.fromCharCode(byte);
      }
    };
    input.on("data", receive);
    input.once("end", ended);
    input.once("error", failed);
    if (tty) input.setRawMode(true);
    prompt("Host credential: ");
    input.resume();
  });
}
