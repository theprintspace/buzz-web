import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  buildPairingEvent,
  constantTimeEqualText,
  decodePairingUri,
  decryptPairingMessage,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  ecdhSharedX,
  encodePairingUri,
  formatSas,
  parsePairingEvent,
  randomDesktopCode,
} from "./nip-ab";

// NIP-AB §Test Vectors (block/buzz crates/buzz-core/src/pairing/NIP-AB.md).
const SESSION_SECRET = hexToBytes(
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
);
const SOURCE_PRIVKEY = hexToBytes(
  "7f4c11a9c9d1e3b5a7f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b5",
);
const SOURCE_PUBKEY = "199e64ca60662cb2d6e91d16cb065be51ad74a6ee5f8c5b0fdc53d246611ed9a";
const TARGET_PRIVKEY = hexToBytes(
  "3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b",
);
const TARGET_PUBKEY = "89a9fa762105d0aee2b19678246fe7b823aabbc4f4bf691a1ce8a70fcd36d6e4";

describe("NIP-AB derivations", () => {
  it("reproduces the specification's key pairs", () => {
    expect(getPublicKey(SOURCE_PRIVKEY)).toBe(SOURCE_PUBKEY);
    expect(getPublicKey(TARGET_PRIVKEY)).toBe(TARGET_PUBKEY);
  });

  it("derives the session id with an empty HKDF salt", () => {
    expect(bytesToHex(deriveSessionId(SESSION_SECRET))).toBe(
      "fb357d0f8e8d5a5ba3b2a91cb18c119e1567b07ffa38cdebb73e68df78f5a380",
    );
  });

  it("uses the unhashed x-coordinate of the shared point, identically from both sides", () => {
    const fromSource = ecdhSharedX(SOURCE_PRIVKEY, TARGET_PUBKEY);
    const fromTarget = ecdhSharedX(TARGET_PRIVKEY, SOURCE_PUBKEY);
    expect(bytesToHex(fromSource)).toBe(
      "9b4b6d6990713d89d6d9982e506ee1bbcde6f05c54d9d2978696e8a7274d4408",
    );
    expect(bytesToHex(fromTarget)).toBe(bytesToHex(fromSource));
  });

  it("derives the SAS input and six-digit code", () => {
    const shared = ecdhSharedX(SOURCE_PRIVKEY, TARGET_PUBKEY);
    const { code, sasInput } = deriveSas(shared, SESSION_SECRET);
    expect(bytesToHex(sasInput)).toBe(
      "e8b03a329f3a0ac37fe7fbe929171e14b72812be67e33c5d6e193543c41798d3",
    );
    expect(code).toBe("863346");
  });

  it("derives the transcript hash over session id, both keys and the SAS input", () => {
    const shared = ecdhSharedX(SOURCE_PRIVKEY, TARGET_PUBKEY);
    const { sasInput } = deriveSas(shared, SESSION_SECRET);
    const hash = deriveTranscriptHash(
      deriveSessionId(SESSION_SECRET),
      SOURCE_PUBKEY,
      TARGET_PUBKEY,
      sasInput,
      SESSION_SECRET,
    );
    expect(bytesToHex(hash)).toBe(
      "d662818ff8911fc60a2d025f8b8b4756107104e85888dd202d28db5ca2cf28d3",
    );
  });

  it("zero-pads the SAS code", () => {
    expect(formatSas(291)).toBe("000291");
    expect(formatSas(47291)).toBe("047291");
    expect(formatSas(999999)).toBe("999999");
    expect(formatSas(0)).toBe("000000");
  });

  it("produces six-digit desktop codes", () => {
    for (let round = 0; round < 50; round += 1) {
      expect(randomDesktopCode()).toMatch(/^\d{6}$/);
    }
  });

  it("compares text without short-circuiting on length", () => {
    expect(constantTimeEqualText("123456", "123456")).toBe(true);
    expect(constantTimeEqualText("123456", "123457")).toBe(false);
    expect(constantTimeEqualText("123456", "12345")).toBe(false);
  });
});

describe("nostrpair URI", () => {
  it("encodes the relay like the Rust reference and decodes it back", () => {
    const uri = encodePairingUri({
      sourcePubkey: SOURCE_PUBKEY,
      sessionSecret: SESSION_SECRET,
      relays: ["wss://pairing.buzz.xyz"],
    });
    expect(uri).toBe(
      `nostrpair://${SOURCE_PUBKEY}?secret=${bytesToHex(SESSION_SECRET)}` +
        "&relay=wss%3A%2F%2Fpairing%2Ebuzz%2Exyz&v=1",
    );
    const decoded = decodePairingUri(uri);
    expect(decoded?.sourcePubkey).toBe(SOURCE_PUBKEY);
    expect(decoded?.relays).toEqual(["wss://pairing.buzz.xyz"]);
    expect(bytesToHex(decoded?.sessionSecret ?? new Uint8Array())).toBe(bytesToHex(SESSION_SECRET));
  });

  it("rejects malformed URIs", () => {
    expect(decodePairingUri("https://example.com")).toBeNull();
    expect(decodePairingUri(`nostrpair://${SOURCE_PUBKEY}`)).toBeNull();
    expect(
      decodePairingUri(`nostrpair://${SOURCE_PUBKEY}?secret=abc&relay=wss%3A%2F%2Fx`),
    ).toBeNull();
    expect(
      decodePairingUri(`nostrpair://${SOURCE_PUBKEY}?secret=${bytesToHex(SESSION_SECRET)}`),
    ).toBeNull();
  });
});

describe("pairing events", () => {
  it("round-trips an encrypted, signed kind 24134 event between the two ephemeral keys", () => {
    const event = buildPairingEvent(
      TARGET_PRIVKEY,
      SOURCE_PUBKEY,
      { type: "offer", version: 1, session_id: bytesToHex(deriveSessionId(SESSION_SECRET)) },
      { now: 1_800_000_000_000, jitterSeconds: 7 },
    );
    expect(event.kind).toBe(24134);
    expect(event.pubkey).toBe(TARGET_PUBKEY);
    expect(event.created_at).toBe(1_800_000_000 - 7);
    expect(event.tags).toEqual([["p", SOURCE_PUBKEY]]);
    expect(parsePairingEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);

    const message = decryptPairingMessage(SOURCE_PRIVKEY, event);
    expect(message).toEqual({
      type: "offer",
      version: 1,
      session_id: bytesToHex(deriveSessionId(SESSION_SECRET)),
    });
  });

  it("discards content outside the NIP-44 size range and unknown message types", () => {
    const event = buildPairingEvent(TARGET_PRIVKEY, SOURCE_PUBKEY, { type: "desktop-code" });
    expect(decryptPairingMessage(SOURCE_PRIVKEY, { ...event, content: "short" })).toBeNull();
    expect(decryptPairingMessage(TARGET_PRIVKEY, event)).toBeNull();
    const unknown = buildPairingEvent(TARGET_PRIVKEY, SOURCE_PUBKEY, {
      type: "mystery",
    } as never);
    expect(decryptPairingMessage(SOURCE_PRIVKEY, unknown)).toBeNull();
  });

  it("rejects structurally wrong events", () => {
    expect(parsePairingEvent(null)).toBeNull();
    expect(parsePairingEvent({ id: "x" })).toBeNull();
    const event = buildPairingEvent(TARGET_PRIVKEY, SOURCE_PUBKEY, { type: "desktop-code" });
    expect(parsePairingEvent({ ...event, kind: 1 })).toBeNull();
    expect(parsePairingEvent({ ...event, tags: [["p", 5]] })).toBeNull();
  });
});
