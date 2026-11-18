import { EventEmitter } from "node:events";
import grpc from "@grpc/grpc-js";

/*
 * Cloud speech over gRPC (HTTP/2), with the subset of the `ws` WebSocket API
 * that CloudTranscriber uses. The gateway carries the WebSocket frames
 * unchanged: one gRPC message is one kind byte plus the frame. The inference
 * service accepts HTTP/2 end-to-end but no WebSocket upgrade, so this is what
 * lets speech share it. See model-api gateway/gemini_transcription/grpc_service.py.
 */
const SERVICE = "/eigenwelt.speech.v1.Speech/";
const METHODS = { "/v1/transcription/live": "Live", "/v1/transcription/diarize": "Diarize" };
const TEXT = 0x01;
const BINARY = 0x02;
const CLOSE = 0x03;
const identity = value => value;
const clients = new Map();

export function isGrpcSpeechUrl(url) {
  return /^grpcs?:/i.test(url);
}

function client(url, maxPayload) {
  const secure = url.protocol === "grpcs:";
  const target = `${url.hostname}:${url.port || (secure ? 443 : 80)}`;
  const key = `${url.protocol}//${target}`;
  if (!clients.has(key)) {
    clients.set(key, new grpc.Client(target, secure ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
      "grpc.max_receive_message_length": maxPayload + 1,
      "grpc.keepalive_time_ms": 30_000,
      "grpc.keepalive_timeout_ms": 10_000,
    }));
  }
  return clients.get(key);
}

export class GrpcSpeechSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  /**
   * @param {string} address
   * @param {{ headers?: Record<string, string>, handshakeTimeout?: number, maxPayload?: number }} [options]
   */
  constructor(address, { headers = {}, handshakeTimeout = 15_000, maxPayload = 1024 * 1024 } = {}) {
    super();
    const url = new URL(address);
    const method = METHODS[url.pathname];
    if (!isGrpcSpeechUrl(address) || !method || url.username || url.password) throw new Error("Invalid cloud speech address.");
    if (url.protocol === "grpc:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Cloud speech requires TLS.");
    this.readyState = GrpcSpeechSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.closeFrame = null;
    this.ended = false;
    const metadata = new grpc.Metadata();
    if (headers.Authorization) metadata.set("authorization", headers.Authorization);
    metadata.set("x-eigenwelt-speech-query", url.search.replace(/^\?/, ""));
    this.call = client(url, maxPayload).makeBidiStreamRequest(SERVICE + method, identity, identity, metadata);
    this.handshake = setTimeout(() => this.abort(new Error("Opening handshake has timed out")), handshakeTimeout);
    this.call.on("metadata", received => {
      if (this.readyState !== GrpcSpeechSocket.CONNECTING || received.get("x-eigenwelt-speech")[0] !== "accepted") return;
      clearTimeout(this.handshake);
      this.readyState = GrpcSpeechSocket.OPEN;
      this.emit("open");
    });
    this.call.on("data", frame => {
      if (this.readyState === GrpcSpeechSocket.CLOSED || !frame.length) return;
      if (frame[0] === TEXT) this.emit("message", frame.subarray(1), false);
      else if (frame[0] === CLOSE) {
        try { this.closeFrame = JSON.parse(frame.subarray(1).toString()); }
        catch { this.closeFrame = { code: 1006, reason: "" }; }
      }
    });
    // Status follows every outcome; errors are reported through it alone.
    this.call.on("error", () => {});
    this.call.on("status", status => {
      if (this.readyState === GrpcSpeechSocket.CLOSED) return;
      clearTimeout(this.handshake);
      const opened = this.readyState !== GrpcSpeechSocket.CONNECTING;
      if (status.code !== grpc.status.OK) {
        // Match `ws`, whose rejected handshakes report the HTTP status.
        const http = { [grpc.status.UNAUTHENTICATED]: 401, [grpc.status.PERMISSION_DENIED]: 403 }[status.code];
        this.emit("error", new Error(http ? `Unexpected server response: ${http}` : "Cloud speech connection failed"));
      } else if (!opened && this.closeFrame) {
        // The gateway closed before accepting: a rejected handshake.
        this.emit("error", new Error("Unexpected server response: 403"));
      }
      this.finish(this.closeFrame?.code ?? 1006, this.closeFrame?.reason ?? "");
    });
  }

  send(data) {
    if (this.readyState === GrpcSpeechSocket.CLOSING || this.readyState === GrpcSpeechSocket.CLOSED) return;
    const payload = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const frame = Buffer.concat([Buffer.of(typeof data === "string" ? TEXT : BINARY), payload]);
    this.bufferedAmount += frame.length;
    this.call.write(frame, () => { this.bufferedAmount -= frame.length; });
  }

  close() {
    this.abort(null, 1005);
  }

  terminate() {
    this.abort(null, 1006);
  }

  abort(error, code = 1006) {
    if (this.readyState === GrpcSpeechSocket.CLOSED) return;
    clearTimeout(this.handshake);
    this.readyState = GrpcSpeechSocket.CLOSING;
    this.call.cancel();
    if (error) this.emit("error", error);
    this.finish(this.closeFrame?.code ?? code, this.closeFrame?.reason ?? "");
  }

  finish(code, reason) {
    if (this.readyState === GrpcSpeechSocket.CLOSED) return;
    this.readyState = GrpcSpeechSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
}
