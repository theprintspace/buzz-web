import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimInviteInBrowser } from "@/features/invite/invite-api";
import { activateLocalSigner, clearActiveSigner } from "@/shared/lib/nostr-signer";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("claimInviteInBrowser", () => {
  afterEach(() => {
    clearActiveSigner();
    vi.unstubAllGlobals();
  });

  it("claims with the unlocked local identity when asked for a local signer", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    activateLocalSigner(secretKey);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        status: "joined",
        community_id: "c1",
        host: "relay.example.com",
        role: "member",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const claim = await claimInviteInBrowser(
      "wss://relay.example.com",
      "v2.code",
      undefined,
      "local",
    );

    expect(claim.status).toBe("joined");
    expect(claim.role).toBe("member");
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://relay.example.com/api/invites/claim");
    expect(request?.body).toBe('{"code":"v2.code"}');
    const authorization = new Headers(request?.headers).get("Authorization") ?? "";
    expect(authorization).toMatch(/^Nostr /);
    const signed = JSON.parse(atob(authorization.slice("Nostr ".length))) as {
      pubkey: string;
      kind: number;
      tags: string[][];
    };
    expect(signed.pubkey).toBe(pubkey);
    expect(signed.kind).toBe(27235);
    expect(signed.tags).toContainEqual(["u", "https://relay.example.com/api/invites/claim"]);
    expect(signed.tags).toContainEqual(["method", "POST"]);
    expect(signed.tags.find((tag) => tag[0] === "payload")?.[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never claims with a throwaway key when no identity is active", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      claimInviteInBrowser("wss://relay.example.com", "v2.code", undefined, "local"),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the relay's error sentinel", async () => {
    activateLocalSigner(generateSecretKey());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invite_expired" }, 403)),
    );

    await expect(
      claimInviteInBrowser("wss://relay.example.com", "v2.code", undefined, "local"),
    ).rejects.toThrow("invite_expired");
  });
});
