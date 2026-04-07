import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { BridgeConfig } from "../config";
import { HomeAssistantApi } from "../ha/api";
import { SatelliteConnection } from "../satellite/connection";
import { WebSocketTransport } from "../satellite/ws-transport";
import { logger } from "../logger";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};

export class WebServer {
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly config: BridgeConfig;
  private readonly haApi: HomeAssistantApi;
  private readonly connections = new Set<SatelliteConnection>();
  private readonly clientDir: string;

  constructor(config: BridgeConfig, haApi: HomeAssistantApi) {
    this.config = config;
    this.haApi = haApi;
    this.clientDir = path.resolve(__dirname, "client");

    this.httpServer = http.createServer((req, res) =>
      this.handleHttp(req, res)
    );
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => this.onWsConnection(ws, req));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.on("error", reject);
      this.httpServer.listen(this.config.webPort, () => {
        logger.info("web.server.started", { port: this.config.webPort });
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const conn of this.connections) {
        conn.close();
      }
      this.connections.clear();

      this.wss.close(() => {
        this.httpServer.close(() => {
          logger.info("web.server.stopped");
          resolve();
        });
      });
    });
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    let urlPath = req.url || "/";

    // Strip query string
    const qIdx = urlPath.indexOf("?");
    if (qIdx !== -1) urlPath = urlPath.slice(0, qIdx);

    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(this.clientDir, urlPath);

    // Prevent directory traversal
    if (!filePath.startsWith(this.clientDir)) {
      res.writeHead(403);
      res.end();
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  }

  private onWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const remoteAddress = req.socket.remoteAddress || "unknown";
    const transport = new WebSocketTransport(ws, remoteAddress);
    const conn = new SatelliteConnection(transport, this.config, this.haApi);
    this.connections.add(conn);

    transport.on("close", () => {
      this.connections.delete(conn);
    });

    logger.info("web.client.connected", { remote_ip: remoteAddress });
  }
}
