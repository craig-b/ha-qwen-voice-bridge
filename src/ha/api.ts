import { logger } from "../logger";
import { BridgeConfig } from "../config";

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

export class HomeAssistantApi {
  private readonly apiUrl: string;
  private readonly token: string;

  constructor(config: BridgeConfig) {
    this.apiUrl = config.haApiUrl;
    this.token = config.supervisorToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HA API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  async getAllStates(): Promise<EntityState[]> {
    return this.request<EntityState[]>("GET", "/states");
  }

  async getState(entityId: string): Promise<EntityState> {
    logger.debug("ha.state.fetched", { entity_id: entityId });
    return this.request<EntityState>("GET", `/states/${entityId}`);
  }

  async callService(
    domain: string,
    service: string,
    entityId: string,
    serviceData?: Record<string, unknown>
  ): Promise<unknown> {
    const body = { entity_id: entityId, ...serviceData };
    logger.info("ha.service.called", { domain, service, entity_id: entityId, success: true });
    return this.request("POST", `/services/${domain}/${service}`, body);
  }
}
