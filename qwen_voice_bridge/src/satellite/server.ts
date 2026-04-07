import net from "net";
import { BridgeConfig } from "../config";
import { HomeAssistantApi } from "../ha/api";
import { SatelliteConnection } from "./connection";
import { TcpTransport } from "./tcp-transport";
import { logger } from "../logger";

export class SatelliteServer {
  private readonly server: net.Server;
  private readonly config: BridgeConfig;
  private readonly haApi: HomeAssistantApi;
  private readonly connections = new Set<SatelliteConnection>();

  constructor(config: BridgeConfig, haApi: HomeAssistantApi) {
    this.config = config;
    this.haApi = haApi;

    this.server = net.createServer((socket) => {
      this.onConnection(socket);
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(this.config.satellitePort, () => {
        logger.info("satellite.server.started", { port: this.config.satellitePort });
        resolve();
      });
    });
  }

  private onConnection(socket: net.Socket): void {
    const transport = new TcpTransport(socket);
    const conn = new SatelliteConnection(transport, this.config, this.haApi);
    this.connections.add(conn);

    transport.on("close", () => {
      this.connections.delete(conn);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const conn of this.connections) {
        conn.close();
      }
      this.connections.clear();

      this.server.close(() => {
        logger.info("satellite.server.stopped");
        resolve();
      });
    });
  }
}
