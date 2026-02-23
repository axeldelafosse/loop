/**
 * Minimal WebSocket client over raw TCP using Bun.connect.
 * Works around Bun's built-in WebSocket client incompatibility
 * with the codex app-server.
 */
import { connect } from "bun";

type MessageHandler = (data: string) => void;
type CloseHandler = () => void;

const WS_OPCODE_TEXT = 0x01;
const WS_OPCODE_CLOSE = 0x08;
const WS_OPCODE_PING = 0x09;
const WS_OPCODE_PONG = 0x0a;
const WS_FIN_BIT = 0x80;
const WS_MASK_BIT = 0x80;
export interface WsClient {
  close(): void;
  onclose: CloseHandler | undefined;
  onmessage: MessageHandler | undefined;
  send(data: string): void;
}

const encodeFrame = (text: string): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const len = payload.length;

  let header: Uint8Array;
  if (len < 126) {
    header = new Uint8Array([WS_FIN_BIT | WS_OPCODE_TEXT, WS_MASK_BIT | len]);
  } else if (len < 65_536) {
    header = new Uint8Array([
      WS_FIN_BIT | WS_OPCODE_TEXT,
      WS_MASK_BIT | 126,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  } else {
    header = new Uint8Array(10);
    header[0] = WS_FIN_BIT | WS_OPCODE_TEXT;
    header[1] = WS_MASK_BIT | 127;
    const view = new DataView(header.buffer);
    view.setBigUint64(2, BigInt(len));
  }

  const masked = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  const frame = new Uint8Array(header.length + 4 + masked.length);
  frame.set(header, 0);
  frame.set(mask, header.length);
  frame.set(masked, header.length + 4);
  return frame;
};

const encodeCloseFrame = (): Uint8Array => {
  const mask = crypto.getRandomValues(new Uint8Array(4));
  return new Uint8Array([
    WS_FIN_BIT | WS_OPCODE_CLOSE,
    WS_MASK_BIT | 0,
    ...mask,
  ]);
};

const encodePongFrame = (payload: Uint8Array): Uint8Array => {
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const len = payload.length;
  const header = new Uint8Array([
    WS_FIN_BIT | WS_OPCODE_PONG,
    WS_MASK_BIT | len,
  ]);
  const masked = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  const frame = new Uint8Array(header.length + 4 + masked.length);
  frame.set(header, 0);
  frame.set(mask, header.length);
  frame.set(masked, header.length + 4);
  return frame;
};

export const connectWs = (url: string): Promise<WsClient> => {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const port = Number(parsed.port) || 80;
  const path = parsed.pathname || "/";

  return new Promise((resolve, reject) => {
    let handshakeDone = false;
    let httpBuffer = "";
    let frameBuffer = new Uint8Array(0);
    let closed = false;

    const client: WsClient = {
      onmessage: undefined,
      onclose: undefined,
      send: () => {
        // no-op until handshake completes
      },
      close: () => {
        // no-op until handshake completes
      },
    };

    const key = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))
    );

    const append = (existing: Uint8Array, chunk: Uint8Array): Uint8Array => {
      const merged = new Uint8Array(existing.length + chunk.length);
      merged.set(existing, 0);
      merged.set(chunk, existing.length);
      return merged;
    };

    const processFrames = (): void => {
      while (frameBuffer.length >= 2) {
        const opcode = frameBuffer[0] & 0x0f;
        const masked = (frameBuffer[1] & WS_MASK_BIT) !== 0;
        let payloadLen = frameBuffer[1] & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (frameBuffer.length < 4) {
            return;
          }
          payloadLen = (frameBuffer[2] << 8) | frameBuffer[3];
          offset = 4;
        } else if (payloadLen === 127) {
          if (frameBuffer.length < 10) {
            return;
          }
          const view = new DataView(frameBuffer.buffer, frameBuffer.byteOffset);
          payloadLen = Number(view.getBigUint64(2));
          offset = 10;
        }

        if (masked) {
          offset += 4;
        }
        if (frameBuffer.length < offset + payloadLen) {
          return;
        }

        const payload = frameBuffer.slice(offset, offset + payloadLen);
        if (masked) {
          const maskKey = frameBuffer.slice(offset - 4, offset);
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i % 4];
          }
        }

        frameBuffer = frameBuffer.slice(offset + payloadLen);

        if (opcode === WS_OPCODE_TEXT) {
          client.onmessage?.(new TextDecoder().decode(payload));
        } else if (opcode === WS_OPCODE_CLOSE) {
          socket?.end(encodeCloseFrame());
        } else if (opcode === WS_OPCODE_PING) {
          socket?.write(encodePongFrame(payload));
        }
      }
    };

    let socket: ReturnType<typeof connect> extends Promise<infer T> ? T : never;

    connect({
      hostname,
      port,
      socket: {
        open(sock) {
          socket = sock;
          sock.write(
            `GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
          );
        },
        data(_sock, data) {
          const chunk =
            data instanceof Uint8Array ? data : new Uint8Array(data);

          if (!handshakeDone) {
            httpBuffer += new TextDecoder().decode(chunk);
            const endIdx = httpBuffer.indexOf("\r\n\r\n");
            if (endIdx === -1) {
              return;
            }
            if (!httpBuffer.startsWith("HTTP/1.1 101")) {
              reject(new Error(`WebSocket upgrade failed: ${httpBuffer}`));
              return;
            }
            handshakeDone = true;

            client.send = (text: string) => {
              if (!closed) {
                socket.write(encodeFrame(text));
              }
            };
            client.close = () => {
              if (closed) {
                return;
              }
              closed = true;
              socket.end(encodeCloseFrame());
            };

            const remaining = httpBuffer.slice(endIdx + 4);
            if (remaining.length > 0) {
              frameBuffer = append(
                frameBuffer,
                new TextEncoder().encode(remaining)
              );
              processFrames();
            }
            resolve(client);
            return;
          }

          frameBuffer = append(frameBuffer, chunk);
          processFrames();
        },
        close() {
          if (!handshakeDone) {
            reject(new Error("WebSocket connection closed before handshake"));
            return;
          }
          closed = true;
          client.onclose?.();
        },
        error(_sock, err) {
          if (!handshakeDone) {
            reject(err);
          }
        },
      },
    }).catch(reject);
  });
};
