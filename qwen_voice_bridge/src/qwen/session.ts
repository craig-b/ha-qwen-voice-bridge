import WebSocket from "ws";
import { EventEmitter } from "events";
import { BridgeConfig } from "../config";
import { logger } from "../logger";
import { QwenSessionConfig } from "./types";
import { HA_TOOLS, executeToolCall } from "../ha/tools";
import { HomeAssistantApi } from "../ha/api";

const DASHSCOPE_WS_URL = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1000;

export interface QwenSessionEvents {
  audio: (pcmData: Buffer) => void;
  response_done: () => void;
  speech_started: () => void;
  error: (err: Error) => void;
  closed: () => void;
}

export class QwenSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly config: BridgeConfig;
  private readonly systemPrompt: string;
  private readonly satelliteId: string;
  private readonly haApi: HomeAssistantApi;
  private closed = false;
  private reconnectAttempts = 0;

  constructor(
    config: BridgeConfig,
    systemPrompt: string,
    satelliteId: string,
    haApi: HomeAssistantApi
  ) {
    super();
    this.config = config;
    this.systemPrompt = systemPrompt;
    this.satelliteId = satelliteId;
    this.haApi = haApi;
  }

  async open(): Promise<void> {
    return this.connect();
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${DASHSCOPE_WS_URL}?model=${this.config.qwenModel}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.dashscopeApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      let resolved = false;

      this.ws.on("open", () => {
        logger.info("qwen.ws.connected", { satellite_id: this.satelliteId, url });
      });

      this.ws.on("message", (raw) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          logger.warn("qwen.ws.invalid_message", { satellite_id: this.satelliteId });
          return;
        }
        this.handleEvent(event);

        if (event.type === "session.created" && !resolved) {
          this.sendSessionUpdate();
        }

        if (event.type === "session.updated" && !resolved) {
          resolved = true;
          this.reconnectAttempts = 0;
          logger.info("qwen.session.opened", {
            satellite_id: this.satelliteId,
            model: this.config.qwenModel,
            voice: this.config.voice,
          });
          resolve();
        }
      });

      this.ws.on("error", (err) => {
        logger.error("qwen.ws.error", {
          satellite_id: this.satelliteId,
          message: err.message,
        });
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.ws.on("close", (code, reason) => {
        logger.warn("qwen.ws.closed", {
          satellite_id: this.satelliteId,
          code,
          reason: reason?.toString() || "",
        });
        if (!this.closed) {
          this.attemptReconnect();
        }
      });
    });
  }

  private sendSessionUpdate(): void {
    const sessionConfig: QwenSessionConfig = {
      modalities: ["text", "audio"],
      instructions: this.systemPrompt,
      voice: this.config.voice,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      turn_detection: { type: "server_vad" },
      tools: HA_TOOLS,
    };

    this.send({ type: "session.update", session: sessionConfig });
  }

  private handleEvent(event: Record<string, unknown>): void {
    const eventType = event.type as string;
    logger.info("qwen.event", { satellite_id: this.satelliteId, type: eventType });

    switch (eventType) {
      case "response.audio.delta": {
        const pcm = Buffer.from(event.delta as string, "base64");
        this.emit("audio", pcm);
        break;
      }

      case "response.audio_transcript.delta":
        logger.debug("qwen.transcript", {
          satellite_id: this.satelliteId,
          delta: event.delta as string,
        });
        break;

      case "response.function_call_arguments.done":
        this.handleToolCall(
          event.call_id as string,
          event.name as string,
          event.arguments as string
        );
        break;

      case "response.done":
        logger.info("qwen.response.completed", { satellite_id: this.satelliteId });
        this.emit("response_done");
        break;

      case "input_audio_buffer.speech_started":
        logger.debug("qwen.speech.detected", { satellite_id: this.satelliteId });
        this.emit("speech_started");
        break;

      case "error": {
        const error = event.error as Record<string, string>;
        logger.error("qwen.api.error", {
          satellite_id: this.satelliteId,
          code: error.code,
          message: error.message,
        });
        this.emit("error", new Error(error.message));
        break;
      }
    }
  }

  private async handleToolCall(callId: string, name: string, argsJson: string): Promise<void> {
    logger.info("qwen.tool_call", {
      satellite_id: this.satelliteId,
      function: name,
      args: argsJson,
    });

    const result = await executeToolCall(this.haApi, name, argsJson);

    // Send tool result back to Qwen
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: result,
      },
    });

    // Prompt Qwen to continue with the result
    this.send({ type: "response.create" });
  }

  sendAudio(pcmData: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({
      type: "input_audio_buffer.append",
      audio: pcmData.toString("base64"),
    });
  }

  private send(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(event));
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (!this.closed) {
        logger.error("qwen.reconnect.exhausted", { satellite_id: this.satelliteId });
        this.emit("error", new Error("Qwen WebSocket reconnection failed"));
      }
      this.emit("closed");
      return;
    }

    this.reconnectAttempts++;
    logger.warn("qwen.reconnect.attempt", {
      satellite_id: this.satelliteId,
      attempt: this.reconnectAttempts,
    });

    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));

    if (this.closed) return;

    try {
      await this.connect();
    } catch (err) {
      logger.error("qwen.reconnect.failed", {
        satellite_id: this.satelliteId,
        attempt: this.reconnectAttempts,
        message: err instanceof Error ? err.message : String(err),
      });
      this.attemptReconnect();
    }
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info("qwen.session.closed", { satellite_id: this.satelliteId });
  }
}
