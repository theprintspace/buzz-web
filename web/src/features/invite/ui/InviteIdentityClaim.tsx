import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { claimInviteInBrowser, type InviteClaimSigner } from "@/features/invite/invite-api";
import { t } from "@/shared/i18n";
import { getActiveSignerMode } from "@/shared/lib/nostr-signer";
import { Button } from "@/shared/ui/button";

type ClaimStatus = "joining" | "joined" | "failed";

/**
 * Rendered once the visitor has an active identity (created, unlocked or a
 * NIP-07 extension): claims the invite with that identity and opens the app.
 */
export function InviteIdentityClaim({
  relayUrl,
  code,
  communityName,
  acceptPolicy,
  mapError,
  onBack,
}: {
  relayUrl: string;
  code: string;
  communityName: string;
  acceptPolicy: () => Promise<string | undefined>;
  mapError: (message: string) => string;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ClaimStatus>("joining");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const claim = useCallback(async () => {
    setStatus("joining");
    setError(null);
    try {
      const receipt = await acceptPolicy();
      const signer: InviteClaimSigner = getActiveSignerMode() === "nip07" ? "nip07" : "local";
      await claimInviteInBrowser(relayUrl, code, receipt, signer);
      setStatus("joined");
      // Client-side navigation keeps the unlocked identity in memory, so the
      // app opens signed in instead of asking for the passphrase again.
      await navigate({ to: "/" });
    } catch (claimError) {
      setStatus("failed");
      setError(
        mapError(claimError instanceof Error ? claimError.message : t("invite.claimFailed")),
      );
    }
  }, [acceptPolicy, code, mapError, navigate, relayUrl]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void claim();
  }, [claim]);

  return (
    <div className="buzz-app-surface flex min-h-dvh items-center justify-center p-4">
      <main className="w-full max-w-[440px] rounded-lg border border-black/10 bg-background/95 p-6 text-center shadow-2xl backdrop-blur-xl dark:border-white/10">
        <h1 className="text-xl font-semibold">{communityName}</h1>
        <p className="mt-1 truncate text-xs text-muted-foreground">{relayUrl}</p>
        {status === "failed" ? (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
            <Button className="h-10 w-full" onClick={() => void claim()}>
              {t("invite.retry")}
            </Button>
            <button
              className="text-xs text-muted-foreground hover:text-foreground"
              type="button"
              onClick={onBack}
            >
              {t("invite.backToInvite")}
            </button>
          </div>
        ) : (
          <p className="mt-6 flex items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            {status === "joined" ? t("invite.joined") : t("invite.joiningCommunity")}
          </p>
        )}
      </main>
    </div>
  );
}
