import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  buildPairingEvent,
  decodePairingUri,
  decryptPairingMessage,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  ecdhSharedX,
  type PairingEvent,
  type PairingMessage,
} from "./nip-ab";
import { PairingSourceSession, type SourceAction } from "./pairing-source-session";

const RELAY = "wss://pairing.example.com";
const PAYLOAD = JSON.stringify({
  relayUrl: "https://relay.example.com",
  pubkey: "f".repeat(64),
  nsec: "nsec1example",
});

/** The phone side, implemented from the specification for the tests. */
class FakePhone {
  readonly secretKey = generateSecretKey();
  readonly pubkey = getPublicKey(this.secretKey);
  readonly sourcePubkey: string;
  readonly sessionSecret: Uint8Array;
  readonly sasCode: string;
  private readonly sasInput: Uint8Array;

  constructor(qrUri: string) {
    const decoded = decodePairingUri(qrUri);
    if (!decoded) throw new Error("bad QR");
    this.sourcePubkey = decoded.sourcePubkey;
    this.sessionSecret = decoded.sessionSecret;
    const sas = deriveSas(ecdhSharedX(this.secretKey, this.sourcePubkey), this.sessionSecret);
    this.sasCode = sas.code;
    this.sasInput = sas.sasInput;
  }

  send(message: PairingMessage): PairingEvent {
    return buildPairingEvent(this.secretKey, this.sourcePubkey, message);
  }

  offer(options: { codeEntry?: boolean; sessionId?: string; version?: number } = {}): PairingEvent {
    return this.send({
      type: "offer",
      version: options.version ?? 1,
      session_id: options.sessionId ?? bytesToHex(deriveSessionId(this.sessionSecret)),
      ...(options.codeEntry === false ? {} : { confirmation: "desktop-code-v1" }),
    });
  }

  read(event: PairingEvent): PairingMessage {
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(this.sourcePubkey);
    expect(event.tags).toEqual([["p", this.pubkey]]);
    const message = decryptPairingMessage(this.secretKey, event);
    if (!message) throw new Error("undecryptable");
    return message;
  }

  expectedTranscriptHash(): string {
    return bytesToHex(
      deriveTranscriptHash(
        deriveSessionId(this.sessionSecret),
        this.sourcePubkey,
        this.pubkey,
        this.sasInput,
        this.sessionSecret,
      ),
    );
  }
}

function published(actions: SourceAction[]): PairingEvent[] {
  return actions.flatMap((action) => (action.type === "publish" ? [action.event] : []));
}

function codeShown(actions: SourceAction[]): { code: string; codeEntry: boolean } | undefined {
  return actions.find((action) => action.type === "code");
}

describe("PairingSourceSession", () => {
  it("shows a QR for its own ephemeral key and the pairing relay", () => {
    const session = new PairingSourceSession({ relayUrl: RELAY, payload: () => PAYLOAD });
    const decoded = decodePairingUri(session.qrUri);
    expect(decoded?.sourcePubkey).toBe(session.pubkey);
    expect(decoded?.relays).toEqual([RELAY]);
    expect(session.state).toBe("waiting");
    expect(session.isExpired()).toBe(false);
    expect(session.isExpired(session.deadline)).toBe(true);
  });

  it("completes the code-entry flow the Buzz phone app uses", () => {
    let releases = 0;
    const session = new PairingSourceSession({
      relayUrl: RELAY,
      payload: () => {
        releases += 1;
        return PAYLOAD;
      },
      desktopCode: () => "123456",
    });
    const phone = new FakePhone(session.qrUri);

    const afterOffer = session.handleEvent(JSON.parse(JSON.stringify(phone.offer())));
    expect(session.state).toBe("confirming");
    expect(session.expectsCodeEntry).toBe(true);
    expect(codeShown(afterOffer)).toEqual({ type: "code", code: "123456", codeEntry: true });
    const [challenge] = published(afterOffer);
    expect(phone.read(challenge)).toEqual({ type: "desktop-code" });
    expect(releases).toBe(0);

    const wrong = session.handleEvent(
      phone.send({ type: "code-submit", code: "000000", request_id: "1" }),
    );
    expect(phone.read(published(wrong)[0])).toEqual({
      type: "code-rejected",
      request_id: "1",
      remaining_attempts: 4,
    });
    expect(session.state).toBe("confirming");
    expect(session.confirmSas()).toEqual([]);

    const right = session.handleEvent(
      phone.send({ type: "code-submit", code: "123456", request_id: "2" }),
    );
    const [confirm, payload] = published(right);
    expect(phone.read(confirm)).toEqual({
      type: "sas-confirm",
      transcript_hash: phone.expectedTranscriptHash(),
    });
    expect(phone.read(payload)).toEqual({
      type: "payload",
      payload_type: "custom",
      payload: PAYLOAD,
    });
    expect(right[right.length - 1]).toEqual({ type: "payload-sent" });
    expect(session.state).toBe("payload-sent");
    expect(releases).toBe(1);

    const done = session.handleEvent(phone.send({ type: "complete", success: true }));
    expect(done).toEqual([{ type: "completed" }]);
    expect(session.state).toBe("completed");
    expect(session.handleEvent(phone.send({ type: "complete", success: true }))).toEqual([]);
  });

  it("falls back to comparing codes when the phone does not ask for code entry", () => {
    const session = new PairingSourceSession({ relayUrl: RELAY, payload: () => PAYLOAD });
    const phone = new FakePhone(session.qrUri);

    const afterOffer = session.handleEvent(phone.offer({ codeEntry: false }));
    expect(published(afterOffer)).toEqual([]);
    expect(codeShown(afterOffer)).toEqual({ type: "code", code: phone.sasCode, codeEntry: false });
    expect(session.expectsCodeEntry).toBe(false);

    const ignored = session.handleEvent(
      phone.send({ type: "code-submit", code: phone.sasCode, request_id: "1" }),
    );
    expect(ignored).toEqual([]);

    const released = session.confirmSas();
    const [confirm, payload] = published(released);
    expect(phone.read(confirm)).toMatchObject({ type: "sas-confirm" });
    expect(phone.read(payload)).toMatchObject({ type: "payload", payload: PAYLOAD });
    expect(session.confirmSas()).toEqual([]);
  });

  it("aborts after five wrong codes", () => {
    const session = new PairingSourceSession({
      relayUrl: RELAY,
      payload: () => PAYLOAD,
      desktopCode: () => "999999",
    });
    const phone = new FakePhone(session.qrUri);
    session.handleEvent(phone.offer());
    let last: SourceAction[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      last = session.handleEvent(
        phone.send({ type: "code-submit", code: "000000", request_id: String(attempt) }),
      );
    }
    expect(phone.read(published(last)[0])).toMatchObject({ remaining_attempts: 0 });
    expect(last[last.length - 1]).toEqual({ type: "failed", failure: "too-many-codes" });
    expect(session.state).toBe("aborted");
    expect(
      session.handleEvent(phone.send({ type: "code-submit", code: "999999", request_id: "6" })),
    ).toEqual([]);
  });

  it("ignores offers with the wrong session id, duplicates and strangers after locking", () => {
    const session = new PairingSourceSession({ relayUrl: RELAY, payload: () => PAYLOAD });
    const impostor = new FakePhone(session.qrUri);
    expect(session.handleEvent(impostor.offer({ sessionId: "0".repeat(64) }))).toEqual([]);
    expect(session.handleEvent(impostor.offer({ sessionId: "not hex" }))).toEqual([]);
    expect(session.state).toBe("waiting");

    const phone = new FakePhone(session.qrUri);
    const offer = phone.offer();
    expect(session.handleEvent(offer).length).toBeGreaterThan(0);
    expect(session.handleEvent(offer)).toEqual([]);
    expect(session.handleEvent(impostor.offer())).toEqual([]);
    expect(
      session.handleEvent(impostor.send({ type: "code-submit", code: "1", request_id: "1" })),
    ).toEqual([]);
    expect(session.handleEvent(impostor.send({ type: "abort", reason: "user_denied" }))).toEqual(
      [],
    );
    expect(session.state).toBe("confirming");
  });

  it("ignores events not addressed to it, tampered events and events after the deadline", () => {
    let now = 1_800_000_000_000;
    const session = new PairingSourceSession({
      relayUrl: RELAY,
      payload: () => PAYLOAD,
      now: () => now,
    });
    const phone = new FakePhone(session.qrUri);
    const other = new FakePhone(session.qrUri);
    const misaddressed = buildPairingEvent(phone.secretKey, other.pubkey, {
      type: "offer",
      session_id: bytesToHex(deriveSessionId(phone.sessionSecret)),
    });
    expect(session.handleEvent(misaddressed)).toEqual([]);
    const offer = phone.offer();
    expect(session.handleEvent({ ...offer, created_at: offer.created_at + 1 })).toEqual([]);
    now = session.deadline;
    expect(session.handleEvent(offer)).toEqual([]);
    expect(session.state).toBe("waiting");
  });

  it("reports a peer abort and a failed import", () => {
    const session = new PairingSourceSession({
      relayUrl: RELAY,
      payload: () => PAYLOAD,
      desktopCode: () => "123456",
    });
    const phone = new FakePhone(session.qrUri);
    session.handleEvent(phone.offer());
    expect(session.handleEvent(phone.send({ type: "abort", reason: "user_denied" }))).toEqual([
      { type: "failed", failure: "peer-aborted", reason: "user_denied" },
    ]);
    expect(session.state).toBe("aborted");

    const second = new PairingSourceSession({
      relayUrl: RELAY,
      payload: () => PAYLOAD,
      desktopCode: () => "123456",
    });
    const secondPhone = new FakePhone(second.qrUri);
    second.handleEvent(secondPhone.offer());
    second.handleEvent(secondPhone.send({ type: "code-submit", code: "123456", request_id: "1" }));
    expect(second.handleEvent(secondPhone.send({ type: "complete", success: false }))).toEqual([
      { type: "failed", failure: "import-failed" },
    ]);
    expect(second.state).toBe("aborted");
  });

  it("rejects offers from a newer protocol version", () => {
    const session = new PairingSourceSession({ relayUrl: RELAY, payload: () => PAYLOAD });
    const phone = new FakePhone(session.qrUri);
    expect(session.handleEvent(phone.offer({ version: 2 }))).toEqual([
      { type: "failed", failure: "unsupported-version" },
    ]);
  });

  it("publishes an abort to a known peer and signs relay AUTH challenges", () => {
    const session = new PairingSourceSession({ relayUrl: RELAY, payload: () => PAYLOAD });
    expect(session.abort("user_denied")).toBeNull();
    expect(session.state).toBe("aborted");

    const live = new PairingSourceSession({ relayUrl: RELAY, payload: () => PAYLOAD });
    const auth = live.signAuth("challenge-1");
    expect(auth.kind).toBe(22242);
    expect(auth.pubkey).toBe(live.pubkey);
    expect(auth.tags).toEqual(
      expect.arrayContaining([
        ["relay", RELAY],
        ["challenge", "challenge-1"],
      ]),
    );
    const phone = new FakePhone(live.qrUri);
    live.handleEvent(phone.offer());
    const abort = live.abort("user_denied");
    expect(abort && phone.read(abort)).toEqual({ type: "abort", reason: "user_denied" });
    expect(live.abort("timeout")).toBeNull();
  });

  it("refuses an all-zero session secret", () => {
    expect(
      () =>
        new PairingSourceSession({
          relayUrl: RELAY,
          payload: () => PAYLOAD,
          sessionSecret: hexToBytes("00".repeat(32)),
        }),
    ).toThrow();
  });
});
