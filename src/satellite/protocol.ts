export const FrameType = {
  HELLO: 0x01,
  AUDIO: 0x02,
  END: 0x03,
  ERROR: 0x04,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  type: FrameTypeValue;
  payload: Buffer;
}

const HEADER_SIZE = 3; // 1 byte type + 2 bytes length

export function encodeFrame(type: FrameTypeValue, payload: Buffer = Buffer.alloc(0)): Buffer {
  const frame = Buffer.alloc(HEADER_SIZE + payload.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt16BE(payload.length, 1);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(data: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames: Frame[] = [];

    while (this.buffer.length >= HEADER_SIZE) {
      const payloadLength = this.buffer.readUInt16BE(1);
      const totalLength = HEADER_SIZE + payloadLength;

      if (this.buffer.length < totalLength) break;

      const type = this.buffer.readUInt8(0) as FrameTypeValue;
      const payload = this.buffer.subarray(HEADER_SIZE, totalLength);
      frames.push({ type, payload: Buffer.from(payload) });

      this.buffer = this.buffer.subarray(totalLength);
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
