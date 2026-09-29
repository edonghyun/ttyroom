export type BrowserSocketData = string | ArrayBuffer;

export interface BrowserSocket {
  send(data: string | ArrayBuffer): void;
  close(): void;
  onOpen(handler: () => void): () => void;
  onMessage(handler: (data: BrowserSocketData | unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  onError(handler: () => void): () => void;
}

export interface BrowserSocketFactory {
  create(url: string): BrowserSocket;
}

export class NativeBrowserSocketFactory implements BrowserSocketFactory {
  create(url: string): BrowserSocket {
    return new NativeBrowserSocket(new WebSocket(url));
  }
}

class NativeBrowserSocket implements BrowserSocket {
  constructor(private readonly socket: WebSocket) {
    this.socket.binaryType = "arraybuffer";
  }

  send(data: string | ArrayBuffer): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }

  onOpen(handler: () => void): () => void {
    this.socket.addEventListener("open", handler);
    return () => this.socket.removeEventListener("open", handler);
  }

  onMessage(handler: (data: unknown) => void): () => void {
    const listener = (event: MessageEvent<unknown>): void => handler(event.data);
    this.socket.addEventListener("message", listener);
    return () => this.socket.removeEventListener("message", listener);
  }

  onClose(handler: () => void): () => void {
    this.socket.addEventListener("close", handler);
    return () => this.socket.removeEventListener("close", handler);
  }

  onError(handler: () => void): () => void {
    this.socket.addEventListener("error", handler);
    return () => this.socket.removeEventListener("error", handler);
  }
}
