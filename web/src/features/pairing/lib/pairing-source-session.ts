// The source side of a NIP-AB pairing session: this browser holds the identity
// and hands it to the Buzz phone app. Pure state machine; the caller owns the
// WebSocket, the timers and the user interface and feeds relay events in.
//
// Mirrors buzz-core's PairingSession (source role) including Buzz's
// "desktop-code-v1" extension: when the phone asks for it in its offer, the
// source shows a separate random six-digit code that the phone user types in,
// and only a correct code releases the identity. Five wrong guesses end the
// session. A phone that does not ask for it falls back to the spec's
// compare-the-codes flow, released by `confirmSas()`.

import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { makeAuthEvent } from "nostr-tools/nip42";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  buildPairingEvent,
  constantTimeEqual,
  constantTimeEqualText,
  DESKTOP_CODE_CONFIRMATION,
  decryptPairingMessage,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  ecdhSharedX,
  encodePairingUri,
  eventAddressedTo,
  isHex32,
  PAIRING_KIND,
  PAIRING_MAX_CODE_ATTEMPTS,
  PAIRING_SESSION_TIMEOUT_MS,
  type PairingEvent,
  parsePairingEvent,
  randomDesktopCode,
} from "./nip-ab";

export type SourceState = "waiting" | "confirming" | "payload-sent" | "completed" | "aborted";

export type PairingFailure =
  | "peer-aborted"
  | "import-failed"
  | "too-many-codes"
  | "unsupported-version";

export type SourceAction =
  | { type: "publish"; event: PairingEvent }
  | { type: "code"; code: string; codeEntry: boolean }
  | { type: "payload-sent" }
  | { type: "completed" }
  | { type: "failed"; failure: PairingFailure; reason?: string };

export type PairingSourceOptions = {
  relayUrl: string;
  /** Produces the custom payload JSON; called once, at the moment the identity is released. */
  payload: () => string;
  now?: () => number;
  secretKey?: Uint8Array;
  sessionSecret?: Uint8Array;
  desktopCode?: () => string;
};

export type AuthEvent = ReturnType<typeof finalizeEvent>;

export class PairingSourceSession {
  readonly pubkey: string;
  readonly qrUri: string;
  readonly relayUrl: string;
  readonly deadline: number;

  private readonly secretKey: Uint8Array;
  private readonly sessionSecret: Uint8Array;
  private readonly sessionId: Uint8Array;
  private readonly now: () => number;
  private readonly payload: () => string;
  private readonly makeDesktopCode: () => string;
  private readonly processed = new Set<string>();
  private stateValue: SourceState = "waiting";
  private peer: string | null = null;
  private sasInput: Uint8Array | null = null;
  private codeEntry = false;
  private desktopCode: string | null = null;
  private codeAttempts = 0;

  constructor(options: PairingSourceOptions) {
    this.relayUrl = options.relayUrl;
    this.payload = options.payload;
    this.now = options.now ?? (() => Date.now());
    this.makeDesktopCode = options.desktopCode ?? randomDesktopCode;
    this.secretKey = options.secretKey ? new Uint8Array(options.secretKey) : generateSecretKey();
    this.sessionSecret = options.sessionSecret
      ? new Uint8Array(options.sessionSecret)
      : randomBytes(32);
    if (this.sessionSecret.length !== 32 || this.sessionSecret.every((byte) => byte === 0)) {
      throw new Error("pairing session secret must be 32 non-zero bytes");
    }
    this.sessionId = deriveSessionId(this.sessionSecret);
    this.pubkey = getPublicKey(this.secretKey);
    this.qrUri = encodePairingUri({
      sourcePubkey: this.pubkey,
      sessionSecret: this.sessionSecret,
      relays: [this.relayUrl],
    });
    this.deadline = this.now() + PAIRING_SESSION_TIMEOUT_MS;
  }

  get state(): SourceState {
    return this.stateValue;
  }

  /** True while the phone is expected to type the code shown here. */
  get expectsCodeEntry(): boolean {
    return this.codeEntry;
  }

  isExpired(now = this.now()): boolean {
    return now >= this.deadline;
  }

  /** NIP-42 answer for relays that challenge, signed with the ephemeral key. */
  signAuth(challenge: string): AuthEvent {
    return finalizeEvent(makeAuthEvent(this.relayUrl, challenge), this.secretKey);
  }

  /** Feed one event from the relay's EVENT frame. Anything invalid or out of order is ignored. */
  handleEvent(raw: unknown): SourceAction[] {
    if (this.terminal() || this.isExpired()) return [];
    const event = parsePairingEvent(raw);
    if (!event || event.kind !== PAIRING_KIND) return [];
    if (this.processed.has(event.id)) return [];
    if (!eventAddressedTo(event, this.pubkey)) return [];
    if (this.peer && event.pubkey !== this.peer) return [];
    if (!verifyEvent(event)) return [];
    const message = decryptPairingMessage(this.secretKey, event);
    if (!message) return [];

    if (this.stateValue === "waiting") {
      return message.type === "offer" ? this.handleOffer(event, message) : [];
    }
    if (message.type === "abort") {
      this.stateValue = "aborted";
      this.processed.add(event.id);
      return [{ type: "failed", failure: "peer-aborted", reason: message.reason }];
    }
    if (this.stateValue === "confirming") {
      if (message.type === "code-submit" && this.codeEntry && this.desktopCode !== null) {
        return this.handleCodeSubmit(event, message.code, message.request_id);
      }
      return [];
    }
    if (this.stateValue === "payload-sent" && message.type === "complete") {
      this.processed.add(event.id);
      if (message.success) {
        this.stateValue = "completed";
        return [{ type: "completed" }];
      }
      this.stateValue = "aborted";
      return [{ type: "failed", failure: "import-failed" }];
    }
    return [];
  }

  /** Compare-the-codes flow only: the person confirmed both screens show the same code. */
  confirmSas(): SourceAction[] {
    if (this.stateValue !== "confirming" || this.codeEntry || this.isExpired()) return [];
    return this.release();
  }

  /** End the session. Returns the abort event to publish when a peer is known. */
  abort(reason: "user_denied" | "timeout" | "protocol_error"): PairingEvent | null {
    if (this.terminal()) return null;
    this.stateValue = "aborted";
    if (!this.peer) return null;
    return buildPairingEvent(this.secretKey, this.peer, { type: "abort", reason });
  }

  dispose(): void {
    this.secretKey.fill(0);
    this.sessionSecret.fill(0);
    this.sessionId.fill(0);
    this.sasInput?.fill(0);
    this.desktopCode = null;
    if (!this.terminal()) this.stateValue = "aborted";
  }

  private terminal(): boolean {
    return this.stateValue === "completed" || this.stateValue === "aborted";
  }

  private handleOffer(
    event: PairingEvent,
    message: { session_id: string; version?: number; confirmation?: string },
  ): SourceAction[] {
    if ((message.version ?? 1) !== 1) {
      this.stateValue = "aborted";
      return [{ type: "failed", failure: "unsupported-version" }];
    }
    if (!isHex32(message.session_id)) return [];
    if (!constantTimeEqual(hexToBytes(message.session_id), this.sessionId)) return [];

    this.peer = event.pubkey;
    const shared = ecdhSharedX(this.secretKey, event.pubkey);
    const { code, sasInput } = deriveSas(shared, this.sessionSecret);
    shared.fill(0);
    this.sasInput = sasInput;
    this.codeEntry = message.confirmation === DESKTOP_CODE_CONFIRMATION;
    this.stateValue = "confirming";
    this.processed.add(event.id);

    if (!this.codeEntry) return [{ type: "code", code, codeEntry: false }];
    this.desktopCode = this.makeDesktopCode();
    const challenge = buildPairingEvent(this.secretKey, event.pubkey, { type: "desktop-code" });
    return [
      { type: "publish", event: challenge },
      { type: "code", code: this.desktopCode, codeEntry: true },
    ];
  }

  private handleCodeSubmit(event: PairingEvent, code: string, requestId: string): SourceAction[] {
    if (!this.peer || this.desktopCode === null) return [];
    this.codeAttempts += 1;
    this.processed.add(event.id);
    if (constantTimeEqualText(code, this.desktopCode)) {
      this.desktopCode = null;
      return this.release();
    }
    const remaining = Math.max(0, PAIRING_MAX_CODE_ATTEMPTS - this.codeAttempts);
    const rejection = buildPairingEvent(this.secretKey, this.peer, {
      type: "code-rejected",
      request_id: requestId,
      remaining_attempts: remaining,
    });
    const actions: SourceAction[] = [{ type: "publish", event: rejection }];
    if (remaining === 0) {
      this.desktopCode = null;
      this.stateValue = "aborted";
      actions.push({ type: "failed", failure: "too-many-codes" });
    }
    return actions;
  }

  private release(): SourceAction[] {
    if (!this.peer || !this.sasInput) return [];
    const transcriptHash = deriveTranscriptHash(
      this.sessionId,
      this.pubkey,
      this.peer,
      this.sasInput,
      this.sessionSecret,
    );
    const confirm = buildPairingEvent(this.secretKey, this.peer, {
      type: "sas-confirm",
      transcript_hash: bytesToHex(transcriptHash),
    });
    const payload = buildPairingEvent(this.secretKey, this.peer, {
      type: "payload",
      payload_type: "custom",
      payload: this.payload(),
    });
    this.stateValue = "payload-sent";
    return [
      { type: "publish", event: confirm },
      { type: "publish", event: payload },
      { type: "payload-sent" },
    ];
  }
}
