import { EventEmitter } from "events";

export interface TransportEvents {
  data: (data: Buffer) => void;
  close: () => void;
  error: (err: Error) => void;
}

export interface Transport {
  readonly remoteAddress: string;
  readonly writable: boolean;
  readonly destroyed: boolean;
  write(data: Buffer): void;
  destroy(): void;
  on<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this;
}

export abstract class BaseTransport extends EventEmitter implements Transport {
  abstract readonly remoteAddress: string;
  abstract readonly writable: boolean;
  abstract readonly destroyed: boolean;
  abstract write(data: Buffer): void;
  abstract destroy(): void;

  on<K extends keyof TransportEvents>(event: K, listener: TransportEvents[K]): this {
    return super.on(event, listener);
  }
}
