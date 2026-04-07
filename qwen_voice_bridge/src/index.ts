import { loadConfig } from "./config";
import { setLogLevel, logger } from "./logger";
import { HomeAssistantApi } from "./ha/api";
import { SatelliteServer } from "./satellite/server";
import { WebServer } from "./web/server";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  logger.info("bridge.starting", {
    model: config.qwenModel,
    voice: config.voice,
    satellite_port: config.satellitePort,
    web_port: config.webPort,
    timeout_s: config.conversationTimeoutSeconds,
  });

  const haApi = new HomeAssistantApi(config);
  const server = new SatelliteServer(config, haApi);
  const webServer = new WebServer(config, haApi);

  await server.start();
  await webServer.start();

  logger.info("bridge.started", {
    satellite_port: config.satellitePort,
    web_port: config.webPort,
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("bridge.stopping");
    await server.stop();
    await webServer.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("bridge.fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
