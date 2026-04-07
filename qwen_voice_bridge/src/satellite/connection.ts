import { BridgeConfig } from "../config";
import { FrameDecoder, FrameType, FrameTypeValue, encodeFrame } from "./protocol";
import { QwenSession } from "../qwen/session";
import { HomeAssistantApi } from "../ha/api";
import { discoverExposedEntities, buildSystemPrompt } from "../ha/entities";
import { logger } from "../logger";
import { Transport } from "./transport";

export type ConnectionState =
  | "CONNECTED"
  | "HELLO_RECEIVED"
  | "CONVERSATION_ACTIVE"
  | "ENDING"
  | "DISCONNECTED";

export class SatelliteConnection {
  private state: ConnectionState = "CONNECTED";
  private satelliteId = "unknown";
  private readonly transport: Transport;
  private readonly config: BridgeConfig;
  private readonly haApi: HomeAssistantApi;
  private readonly decoder = new FrameDecoder();
  private qwenSession: QwenSession | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout>;
  private readonly remoteIp: string;

  constructor(transport: Transport, config: BridgeConfig, haApi: HomeAssistantApi) {
    this.transport = transport;
    this.config = config;
    this.haApi = haApi;
    this.remoteIp = transport.remoteAddress;

    // HELLO must arrive within 2 seconds
    this.helloTimer = setTimeout(() => {
      if (this.state === "CONNECTED") {
        logger.warn("satellite.hello_timeout", { remote_ip: this.remoteIp });
        this.close();
      }
    }, 2000);

    this.transport.on("data", (data) => this.onData(data));
    this.transport.on("close", () => this.onDisconnect());
    this.transport.on("error", (err) => {
      logger.warn("satellite.socket_error", {
        satellite_id: this.satelliteId,
        message: err.message,
      });
      this.close();
    });
  }

  private onData(data: Buffer): void {
    const frames = this.decoder.push(data);
    for (const frame of frames) {
      switch (frame.type) {
        case FrameType.HELLO:
          this.onHello(frame.payload.toString("utf-8"));
          break;
        case FrameType.AUDIO:
          this.onAudio(frame.payload);
          break;
        default:
          logger.warn("satellite.invalid_frame", {
            satellite_id: this.satelliteId,
            type: frame.type,
          });
          this.close();
          break;
      }
    }
  }

  private async onHello(satelliteId: string): Promise<void> {
    if (this.state !== "CONNECTED") {
      logger.warn("satellite.unexpected_hello", { satellite_id: satelliteId });
      return;
    }

    clearTimeout(this.helloTimer);
    this.satelliteId = satelliteId;
    this.state = "HELLO_RECEIVED";

    logger.info("satellite.connected", {
      satellite_id: this.satelliteId,
      remote_ip: this.remoteIp,
    });

    try {
      // Discover entities and build system prompt
      const entities = await discoverExposedEntities(this.config, this.haApi);
      const systemPrompt = buildSystemPrompt(
        this.config.personaPrompt,
        entities,
        this.satelliteId
      );

      // Open Qwen session
      this.qwenSession = new QwenSession(
        this.config,
        systemPrompt,
        this.satelliteId,
        this.haApi
      );

      this.qwenSession.on("audio", (pcm: Buffer) => {
        if (this.state === "CONVERSATION_ACTIVE" || this.state === "HELLO_RECEIVED") {
          this.sendFrame(FrameType.AUDIO, pcm);
        }
      });

      this.qwenSession.on("response_done", () => {
        this.resetSilenceTimer();
      });

      this.qwenSession.on("error", (err: Error) => {
        this.sendFrame(FrameType.ERROR, Buffer.from(err.message, "utf-8"));
        this.close();
      });

      this.qwenSession.on("closed", () => {
        if (this.state !== "DISCONNECTED" && this.state !== "ENDING") {
          this.sendFrame(FrameType.ERROR, Buffer.from("Qwen session lost", "utf-8"));
          this.close();
        }
      });

      await this.qwenSession.open();
      this.state = "CONVERSATION_ACTIVE";
      // Start initial silence timer (in case user doesn't speak)
      this.resetSilenceTimer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("qwen.session.open_failed", {
        satellite_id: this.satelliteId,
        message: msg,
      });
      this.sendFrame(FrameType.ERROR, Buffer.from(`Failed to connect to Qwen: ${msg}`, "utf-8"));
      this.close();
    }
  }

  private onAudio(pcmData: Buffer): void {
    if (this.state !== "CONVERSATION_ACTIVE") return;
    this.qwenSession?.sendAudio(pcmData);
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.endConversation();
    }, this.config.conversationTimeoutSeconds * 1000);
  }

  private endConversation(): void {
    if (this.state !== "CONVERSATION_ACTIVE") return;
    this.state = "ENDING";

    logger.info("conversation.timeout", {
      satellite_id: this.satelliteId,
      timeout_s: this.config.conversationTimeoutSeconds,
    });

    this.qwenSession?.close();
    this.sendFrame(FrameType.END);
    this.close();
  }

  private sendFrame(type: FrameTypeValue, payload?: Buffer): void {
    if (this.transport.writable) {
      this.transport.write(encodeFrame(type, payload));
    }
  }

  close(): void {
    if (this.state === "DISCONNECTED") return;
    this.state = "DISCONNECTED";

    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    clearTimeout(this.helloTimer);
    this.qwenSession?.close();
    this.decoder.reset();

    if (!this.transport.destroyed) {
      this.transport.destroy();
    }

    logger.info("satellite.disconnected", {
      satellite_id: this.satelliteId,
      reason: "closed",
    });
  }

  private onDisconnect(): void {
    if (this.state === "DISCONNECTED") return;
    logger.info("satellite.disconnected", {
      satellite_id: this.satelliteId,
      reason: "remote_close",
    });
    this.state = "DISCONNECTED";
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    clearTimeout(this.helloTimer);
    this.qwenSession?.close();
  }
}
