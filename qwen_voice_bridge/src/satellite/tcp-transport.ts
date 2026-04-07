import net from "net";
import { BaseTransport } from "./transport";

export class TcpTransport extends BaseTransport {
  private readonly socket: net.Socket;

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;

    socket.on("data", (data) => this.emit("data", data));
    socket.on("close", () => this.emit("close"));
    socket.on("error", (err) => this.emit("error", err));
  }

  get remoteAddress(): string {
    return this.socket.remoteAddress || "unknown";
  }

  get writable(): boolean {
    return this.socket.writable;
  }

  get destroyed(): boolean {
    return this.socket.destroyed;
  }

  write(data: Buffer): void {
    this.socket.write(data);
  }

  destroy(): void {
    this.socket.destroy();
  }
}
