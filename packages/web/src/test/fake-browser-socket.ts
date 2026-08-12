import type {
  BrowserSocket,
  BrowserSocketData,
  BrowserSocketFactory,
} from "../transport/browser-socket.js";

export class FakeBrowserSocket implements BrowserSocket {
  readonly sent: Array<string | ArrayBuffer> = [];
  closeCount = 0;
  private openHandler: (() => void) | null = null;
  private messageHandler: ((data: BrowserSocketData | unknown) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: (() => void) | null = null;

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
  }

  onOpen(handler: () => void): () => void {
    this.openHandler = handler;
    return () => {
      this.openHandler = null;
    };
  }

  onMessage(handler: (data: BrowserSocketData | unknown) => void): () => void {
    this.messageHandler = handler;
    return () => {
      this.messageHandler = null;
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandler = handler;
    return () => {
      this.closeHandler = null;
    };
  }

  onError(handler: () => void): () => void {
    this.errorHandler = handler;
    return () => {
      this.errorHandler = null;
    };
  }

  open(): void {
    this.openHandler?.();
  }

  message(data: BrowserSocketData | unknown): void {
    this.messageHandler?.(data);
  }

  closed(): void {
    this.closeHandler?.();
  }

  failed(): void {
    this.errorHandler?.();
  }
}

export class FakeBrowserSocketFactory implements BrowserSocketFactory {
  readonly sockets: FakeBrowserSocket[] = [];
  readonly urls: string[] = [];

  create(url: string): FakeBrowserSocket {
    const socket = new FakeBrowserSocket();
    this.urls.push(url);
    this.sockets.push(socket);
    return socket;
  }
}
