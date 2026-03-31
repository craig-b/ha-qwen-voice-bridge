import { loadConfig } from "./config";
import { setLogLevel, logger } from "./logger";
import { HomeAssistantApi } from "./ha/api";
import { SatelliteServer } from "./satellite/server";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  logger.info("bridge.starting", {
    model: config.qwenModel,
    voice: config.voice,
    port: config.satellitePort,
    timeout_s: config.conversationTimeoutSeconds,
  });

  const haApi = new HomeAssistantApi(config);
  const server = new SatelliteServer(config, haApi);

  await server.start();

  logger.info("bridge.started", { port: config.satellitePort });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("bridge.stopping");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.error("bridge.fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
