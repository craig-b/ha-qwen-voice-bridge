import { QwenToolDefinition } from "../qwen/types";
import { HomeAssistantApi } from "./api";
import { logger } from "../logger";

export const HA_TOOLS: QwenToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "call_service",
      description:
        "Control a smart home device by calling a Home Assistant service. Use this when the user wants to change something (turn on/off lights, set temperature, lock/unlock doors, etc).",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description:
              "The entity domain (e.g. light, switch, climate, lock, cover, media_player)",
          },
          service: {
            type: "string",
            description:
              "The service to call (e.g. turn_on, turn_off, toggle, set_temperature, lock, unlock, open_cover, close_cover)",
          },
          entity_id: {
            type: "string",
            description:
              "The entity_id to act on (e.g. light.kitchen, climate.living_room)",
          },
          service_data: {
            type: "object",
            description:
              'Optional additional service data (e.g. {"brightness": 128} for lights, {"temperature": 21} for climate)',
          },
        },
        required: ["domain", "service", "entity_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_state",
      description:
        "Get the current state and attributes of a smart home device. Use this when the user asks about the status of something.",
      parameters: {
        type: "object",
        properties: {
          entity_id: {
            type: "string",
            description:
              "The entity_id to query (e.g. sensor.outdoor_temperature, light.bedroom)",
          },
        },
        required: ["entity_id"],
      },
    },
  },
];

export interface ToolCallArgs {
  domain?: string;
  service?: string;
  entity_id: string;
  service_data?: Record<string, unknown>;
}

export async function executeToolCall(
  api: HomeAssistantApi,
  functionName: string,
  argsJson: string
): Promise<string> {
  let args: ToolCallArgs;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({ error: "Invalid JSON arguments" });
  }

  logger.info("qwen.tool_call", { function: functionName, args });

  try {
    if (functionName === "call_service") {
      if (!args.domain || !args.service || !args.entity_id) {
        return JSON.stringify({ error: "Missing required parameters: domain, service, entity_id" });
      }
      const result = await api.callService(
        args.domain,
        args.service,
        args.entity_id,
        args.service_data
      );
      return JSON.stringify({ success: true, result });
    }

    if (functionName === "get_state") {
      if (!args.entity_id) {
        return JSON.stringify({ error: "Missing required parameter: entity_id" });
      }
      const state = await api.getState(args.entity_id);
      return JSON.stringify(state);
    }

    return JSON.stringify({ error: `Unknown function: ${functionName}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("ha.tool_call.failed", { function: functionName, message });
    return JSON.stringify({ error: message });
  }
}
