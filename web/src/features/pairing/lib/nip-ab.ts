// NIP-AB device pairing primitives, as implemented by Block's Buzz
// (crates/buzz-core/src/pairing/NIP-AB.md in github.com/block/buzz).
//
// The source (this browser) shows a QR code with an ephemeral public key, a
// session secret and the pairing relay. The target (the Buzz phone app) scans
// it and both sides talk over kind 24134 events, NIP-44 encrypted between the
// two ephemeral keys. The relay only ever sees throwaway keys and ciphertext.
//
// This module is pure: no React, no i18n, no sockets. The Playwright suite
// imports it to play the phone side, so keep it free of `@/` path aliases.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import {
  getConversationKey,
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
} from "nostr-tools/nip44";
import { finalizeEvent } from "nostr-tools/pure";

export const PAIRING_KIND = 24134;
export const PAIRING_SESSION_TIMEOUT_MS = 120_000;
export const PAIRING_STEP_TIMEOUT_MS = 30_000;
export const PAIRING_MAX_CODE_ATTEMPTS = 5;
export const PAIRING_SUBSCRIPTION_ID = "pair";
/** Block's open, stateless NIP-AB relay; the same one its hosted communities advertise. */
export const DEFAULT_PAIRING_RELAY_URL = "wss://pairing.buzz.xyz";
/** Offer capability: the phone wants to type a code shown only here, instead of comparing codes. */
export const DESKTOP_CODE_CONFIRMATION = "desktop-code-v1";

const MIN_CONTENT_LENGTH = 132;
const MAX_CONTENT_LENGTH = 87_472;
const MAX_PLAINTEXT_BYTES = 65_535;
const HEX_32 = /^[0-9a-f]{64}$/;

export type PairingPayloadType = "nsec" | "bunker" | "connect" | "custom";

export type PairingMessage =
  | { type: "offer"; session_id: string; version?: number; confirmation?: string }
  | { type: "desktop-code" }
  | { type: "code-submit"; code: string; request_id: string }
  | { type: "code-rejected"; request_id: string; remaining_attempts: number }
  | { type: "sas-confirm"; transcript_hash: string }
  | { type: "payload"; payload_type: PairingPayloadType; payload: string }
  | { type: "complete"; success: boolean }
  | { type: "abort"; reason: string };

export type PairingEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

export function isHex32(value: unknown): value is string {
  return typeof value === "string" && HEX_32.test(value);
}

export function deriveSessionId(sessionSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sessionSecret, new Uint8Array(0), utf8ToBytes("nostr-pair-session-id"), 32);
}

/** Unhashed x-coordinate of the shared secp256k1 point, as NIP-AB requires. */
export function ecdhSharedX(secretKey: Uint8Array, peerPubkey: string): Uint8Array {
  const point = secp256k1.getSharedSecret(secretKey, hexToBytes(`02${peerPubkey}`), true);
  const x = point.slice(1);
  point.fill(0);
  return x;
}

export function formatSas(code: number): string {
  return String(code % 1_000_000).padStart(6, "0");
}

export function deriveSas(
  ecdhShared: Uint8Array,
  sessionSecret: Uint8Array,
): { code: string; sasInput: Uint8Array } {
  const sasInput = hkdf(sha256, ecdhShared, sessionSecret, utf8ToBytes("nostr-pair-sas-v1"), 32);
  const head = new DataView(sasInput.buffer, sasInput.byteOffset, 4).getUint32(0, false);
  return { code: formatSas(head), sasInput };
}

export function deriveTranscriptHash(
  sessionId: Uint8Array,
  sourcePubkey: string,
  targetPubkey: string,
  sasInput: Uint8Array,
  sessionSecret: Uint8Array,
): Uint8Array {
  const transcript = concatBytes(
    sessionId,
    hexToBytes(sourcePubkey),
    hexToBytes(targetPubkey),
    sasInput,
  );
  return hkdf(sha256, transcript, sessionSecret, utf8ToBytes("nostr-pair-transcript-v1"), 32);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export function constantTimeEqualText(a: string, b: string): boolean {
  return constantTimeEqual(utf8ToBytes(a), utf8ToBytes(b));
}

/** Random six-digit code shown only on the source for the code-entry confirmation. */
export function randomDesktopCode(): string {
  const bytes = randomBytes(4);
  return formatSas(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false));
}

/** NIP-AB §Metadata Privacy: created_at is set 0 to 30 seconds in the past. */
export function randomJitterSeconds(): number {
  return randomBytes(1)[0] % 31;
}

// The Rust reference encodes every non-alphanumeric byte (dots included); the
// phone percent-decodes, so matching it exactly keeps the two in step.
function percentEncodeAll(value: string): string {
  let out = "";
  for (const byte of utf8ToBytes(value)) {
    const char = String.fromCharCode(byte);
    out += /[0-9A-Za-z]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function encodePairingUri(input: {
  sourcePubkey: string;
  sessionSecret: Uint8Array;
  relays: string[];
}): string {
  const relays = input.relays.map((relay) => `&relay=${percentEncodeAll(relay)}`).join("");
  return `nostrpair://${input.sourcePubkey}?secret=${bytesToHex(input.sessionSecret)}${relays}&v=1`;
}

export function decodePairingUri(
  uri: string,
): { sourcePubkey: string; sessionSecret: Uint8Array; relays: string[] } | null {
  if (!uri.startsWith("nostrpair://") || uri.length > 2048) return null;
  const [sourcePubkey, query = ""] = uri.slice("nostrpair://".length).split("?", 2);
  if (!isHex32(sourcePubkey)) return null;
  let secret: string | null = null;
  const relays: string[] = [];
  for (const pair of query.split("&")) {
    const [key, value = ""] = pair.split("=", 2);
    if (key === "secret") secret = value;
    if (key === "relay") relays.push(decodeURIComponent(value));
  }
  if (!isHex32(secret) || relays.length === 0) return null;
  return { sourcePubkey, sessionSecret: hexToBytes(secret), relays };
}

export function buildPairingEvent(
  secretKey: Uint8Array,
  peerPubkey: string,
  message: PairingMessage,
  options: { now?: number; jitterSeconds?: number } = {},
): PairingEvent {
  const conversationKey = getConversationKey(secretKey, peerPubkey);
  try {
    const content = nip44Encrypt(JSON.stringify(message), conversationKey);
    const now = Math.floor((options.now ?? Date.now()) / 1000);
    const jitter = options.jitterSeconds ?? randomJitterSeconds();
    const signed = finalizeEvent(
      { kind: PAIRING_KIND, created_at: now - jitter, tags: [["p", peerPubkey]], content },
      secretKey,
    );
    return {
      id: signed.id,
      pubkey: signed.pubkey,
      kind: signed.kind,
      created_at: signed.created_at,
      tags: signed.tags,
      content: signed.content,
      sig: signed.sig,
    };
  } finally {
    conversationKey.fill(0);
  }
}

/** Structural check of a relay EVENT frame's event; signatures are verified separately. */
export function parsePairingEvent(value: unknown): PairingEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (!isHex32(event.id) || !isHex32(event.pubkey)) return null;
  if (event.kind !== PAIRING_KIND) return null;
  if (typeof event.created_at !== "number" || typeof event.content !== "string") return null;
  if (typeof event.sig !== "string" || !/^[0-9a-f]{128}$/.test(event.sig)) return null;
  if (!Array.isArray(event.tags)) return null;
  const tags: string[][] = [];
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || !tag.every((item) => typeof item === "string")) return null;
    tags.push(tag);
  }
  return {
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    tags,
    content: event.content,
    sig: event.sig,
  };
}

export function eventAddressedTo(event: PairingEvent, pubkey: string): boolean {
  return event.tags.some((tag) => tag[0] === "p" && tag[1] === pubkey);
}

/**
 * Decrypt a kind 24134 event's content with our ephemeral key. Returns null for
 * anything NIP-AB says to discard silently: wrong size, bad ciphertext, oversized
 * or malformed plaintext, unknown message type.
 */
export function decryptPairingMessage(
  secretKey: Uint8Array,
  event: PairingEvent,
): PairingMessage | null {
  if (event.content.length < MIN_CONTENT_LENGTH || event.content.length > MAX_CONTENT_LENGTH) {
    return null;
  }
  const conversationKey = getConversationKey(secretKey, event.pubkey);
  try {
    const plaintext = nip44Decrypt(event.content, conversationKey);
    if (utf8ToBytes(plaintext).length > MAX_PLAINTEXT_BYTES) return null;
    const parsed: unknown = JSON.parse(plaintext);
    return isPairingMessage(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    conversationKey.fill(0);
  }
}

function isPairingMessage(value: unknown): value is PairingMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "offer":
      return (
        typeof message.session_id === "string" &&
        (message.version === undefined || typeof message.version === "number") &&
        (message.confirmation === undefined || typeof message.confirmation === "string")
      );
    case "desktop-code":
      return true;
    case "code-submit":
      return typeof message.code === "string" && typeof message.request_id === "string";
    case "code-rejected":
      return (
        typeof message.request_id === "string" && typeof message.remaining_attempts === "number"
      );
    case "sas-confirm":
      return typeof message.transcript_hash === "string";
    case "payload":
      return typeof message.payload_type === "string" && typeof message.payload === "string";
    case "complete":
      return typeof message.success === "boolean";
    case "abort":
      return typeof message.reason === "string";
    default:
      return false;
  }
}
