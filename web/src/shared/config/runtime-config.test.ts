import { describe, expect, it } from "vitest";
import { normalizeOptionalRelayUrl, normalizeRelayUrl } from "@/shared/config/runtime-config";

describe("runtime Relay configuration", () => {
  it("requires an explicit WebSocket Relay address", () => {
    expect(() => normalizeRelayUrl("")).toThrow();
    expect(() => normalizeRelayUrl("not a url")).toThrow();
    expect(() => normalizeRelayUrl("https://relay.example.com")).toThrow();
  });

  it("normalizes valid ws and wss addresses", () => {
    expect(normalizeRelayUrl("wss://relay.example.com/")).toBe("wss://relay.example.com");
    expect(normalizeRelayUrl("ws://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000");
  });

  it("treats the pairing relay as optional but validates it when present", () => {
    expect(normalizeOptionalRelayUrl(undefined)).toBeNull();
    expect(normalizeOptionalRelayUrl("")).toBeNull();
    expect(normalizeOptionalRelayUrl("wss://pairing.buzz.xyz/")).toBe("wss://pairing.buzz.xyz");
    expect(() => normalizeOptionalRelayUrl("https://pairing.buzz.xyz")).toThrow();
  });
});
