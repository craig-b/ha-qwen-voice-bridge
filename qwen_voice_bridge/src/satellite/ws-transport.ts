import WebSocket from "ws";
import { BaseTransport } from "./transport";

export class WebSocketTransport extends BaseTransport {
  private readonly ws: WebSocket;
  private readonly _remoteAddress: string;

  constructor(ws: WebSocket, remoteAddress: string) {
    super();
    this.ws = ws;
    this._remoteAddress = remoteAddress;

    ws.on("message", (data: WebSocket.RawData) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      this.emit("data", buf);
    });
    ws.on("close", () => this.emit("close"));
    ws.on("error", (err) => this.emit("error", err));
  }

  get remoteAddress(): string {
    return this._remoteAddress;
  }

  get writable(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  get destroyed(): boolean {
    return (
      this.ws.readyState === WebSocket.CLOSED ||
      this.ws.readyState === WebSocket.CLOSING
    );
  }

  write(data: Buffer): void {
    this.ws.send(data);
  }

  destroy(): void {
    this.ws.close();
  }
}
