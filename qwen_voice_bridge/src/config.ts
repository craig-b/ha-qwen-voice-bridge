import { LogLevel } from "./logger";

export interface BridgeConfig {
  dashscopeApiKey: string;
  qwenModel: string;
  voice: string;
  personaPrompt: string;
  satellitePort: number;
  webPort: number;
  conversationTimeoutSeconds: number;
  logLevel: LogLevel;
  supervisorToken: string;
  haApiUrl: string;
  haWsUrl: string;
}

export function loadConfig(): BridgeConfig {
  const dashscopeApiKey = requireEnv("DASHSCOPE_API_KEY");
  const supervisorToken = requireEnv("SUPERVISOR_TOKEN");

  return {
    dashscopeApiKey,
    qwenModel: process.env.QWEN_MODEL || "qwen3.5-omni-flash-realtime",
    voice: process.env.VOICE || "Ethan",
    personaPrompt:
      process.env.PERSONA_PROMPT ||
      "You are a helpful voice assistant for a smart home. Keep responses concise and conversational.",
    satellitePort: parseInt(process.env.SATELLITE_PORT || "9100", 10),
    webPort: parseInt(process.env.WEB_PORT || "9101", 10),
    conversationTimeoutSeconds: parseInt(process.env.CONVERSATION_TIMEOUT || "15", 10),
    logLevel: (process.env.LOG_LEVEL as LogLevel) || "info",
    supervisorToken,
    haApiUrl: process.env.HA_API_URL || "http://supervisor/core/api",
    haWsUrl: process.env.HA_WS_URL || "ws://supervisor/core/api/websocket",
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}
