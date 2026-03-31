import WebSocket from "ws";
import { BridgeConfig } from "../config";
import { HomeAssistantApi, EntityState } from "./api";
import { logger } from "../logger";

export interface ExposedEntity {
  entityId: string;
  friendlyName: string;
  state: string;
  keyAttributes: string;
}

export async function discoverExposedEntities(
  config: BridgeConfig,
  api: HomeAssistantApi
): Promise<ExposedEntity[]> {
  let exposedIds: Set<string>;
  try {
    exposedIds = await fetchExposedEntityIds(config);
  } catch (err) {
    logger.warn("ha.expose_list.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    // Fallback: use all entities
    const allStates = await api.getAllStates();
    return allStates.map(stateToExposedEntity);
  }

  const allStates = await api.getAllStates();
  const filtered = allStates.filter((s) => exposedIds.has(s.entity_id));
  return filtered.map(stateToExposedEntity);
}

function stateToExposedEntity(s: EntityState): ExposedEntity {
  const friendlyName = (s.attributes.friendly_name as string) || s.entity_id;
  const keyAttrs = formatKeyAttributes(s);
  return {
    entityId: s.entity_id,
    friendlyName,
    state: s.state,
    keyAttributes: keyAttrs,
  };
}

function formatKeyAttributes(s: EntityState): string {
  const parts: string[] = [];
  const a = s.attributes;
  if (a.brightness !== undefined) parts.push(`brightness ${Math.round((a.brightness as number) / 255 * 100)}%`);
  if (a.temperature !== undefined) parts.push(`target ${a.temperature}°C`);
  if (a.current_temperature !== undefined) parts.push(`current ${a.current_temperature}°C`);
  if (a.position !== undefined) parts.push(`position ${a.position}%`);
  if (a.unit_of_measurement !== undefined && s.state !== "unavailable") {
    return `${s.state}${a.unit_of_measurement}`;
  }
  if (parts.length === 0) return s.state;
  return `${s.state}, ${parts.join(", ")}`;
}

function fetchExposedEntityIds(config: BridgeConfig): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.haWsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket timeout fetching exposed entities"));
    }, 10_000);

    let msgId = 1;

    ws.on("open", () => {
      // Wait for auth_required message
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: config.supervisorToken }));
        return;
      }

      if (msg.type === "auth_ok") {
        ws.send(
          JSON.stringify({ type: "homeassistant/expose_entity/list", id: msgId++ })
        );
        return;
      }

      if (msg.type === "auth_invalid") {
        clearTimeout(timeout);
        ws.close();
        reject(new Error("HA WebSocket auth failed"));
        return;
      }

      if (msg.type === "result" && msg.success) {
        clearTimeout(timeout);
        ws.close();
        const exposed = msg.result?.exposed_entities ?? msg.result ?? {};
        const ids = new Set<string>();
        // The response format has entity_ids as keys with exposure settings
        for (const [entityId, settings] of Object.entries(exposed)) {
          const s = settings as Record<string, unknown>;
          // Include if exposed to any assistant
          if (s.conversation !== false) {
            ids.add(entityId);
          }
        }
        resolve(ids);
        return;
      }

      if (msg.type === "result" && !msg.success) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`HA WS error: ${JSON.stringify(msg.error)}`));
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export function buildDeviceContext(entities: ExposedEntity[], maxEntities = 200): string {
  const capped = entities.slice(0, maxEntities);
  if (capped.length === 0) return "No devices are currently available.";

  const lines = capped.map(
    (e) => `- ${e.friendlyName} (${e.entityId}): ${e.keyAttributes}`
  );
  return "Available devices:\n\n" + lines.join("\n");
}

export function buildSystemPrompt(
  personaPrompt: string,
  entities: ExposedEntity[],
  satelliteId: string
): string {
  const deviceContext = buildDeviceContext(entities);
  const satelliteContext = `The user is speaking from the ${satelliteId.replace(/-/g, " ")}.`;

  return [personaPrompt, "", deviceContext, "", satelliteContext].join("\n");
}
