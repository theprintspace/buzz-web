import { Check, Copy, LoaderCircle, RefreshCw, Smartphone, TriangleAlert } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback } from "react";
import { toast } from "sonner";
import { type PairingStep, usePhonePairing } from "@/features/pairing/use-phone-pairing";
import { relayHttpOrigin } from "@/shared/config/runtime-config";
import { t } from "@/shared/i18n";
import { exportActiveIdentity, getActiveSignerMode } from "@/shared/lib/nostr-signer";

export const IOS_APP_URL = "https://apps.apple.com/app/id6779728271";
export const ANDROID_APP_URL =
  "https://play.google.com/store/apps/details?id=xyz.block.buzz.mobile";

const DIGIT_POSITIONS = [0, 1, 2, 3, 4, 5] as const;

function stepProgress(step: PairingStep) {
  const scanned = ["code", "transferring", "unconfirmed", "done"].includes(step);
  const confirmed = ["transferring", "unconfirmed", "done"].includes(step);
  return { scanned, confirmed, paired: step === "done" };
}

function StepRow({
  number,
  done,
  title,
  body,
}: {
  number: number;
  done: boolean;
  title: string;
  body: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
          done ? "bg-green-600 text-white" : "bg-foreground/8 text-foreground/80"
        }`}
      >
        {done ? <Check className="h-4 w-4" /> : number}
      </span>
      <div className="min-w-0 pt-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{body}</p>
      </div>
    </li>
  );
}

function CodeDigits({ code }: { code: string }) {
  return (
    <div
      aria-label={t("pairing.codeLabel", { code: `${code.slice(0, 3)} ${code.slice(3)}` })}
      className="flex justify-center gap-1.5"
      data-code={code}
      data-testid="pairing-code"
      role="img"
    >
      {DIGIT_POSITIONS.map((position) => (
        <span
          aria-hidden="true"
          className={`flex h-12 w-9 items-center justify-center rounded-md border bg-background font-mono text-2xl font-semibold ${
            position === 3 ? "ml-2" : ""
          }`}
          key={position}
        >
          {code[position] ?? ""}
        </span>
      ))}
    </div>
  );
}

const SECONDARY_BUTTON =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-foreground/5";
const PRIMARY_BUTTON =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground";

export function PhonePairingSection({
  relayUrl,
  pairingRelayUrl,
}: {
  relayUrl: string;
  pairingRelayUrl: string | null;
}) {
  const localIdentity = getActiveSignerMode() === "local";
  const payload = useCallback(() => {
    const identity = exportActiveIdentity();
    return JSON.stringify({
      relayUrl: relayHttpOrigin(relayUrl),
      pubkey: identity.pubkey,
      nsec: identity.nsec,
    });
  }, [relayUrl]);
  const pairing = usePhonePairing({ relayUrl, pairingRelayUrl, payload });
  const progress = stepProgress(pairing.step);
  const stepTwoTitle = pairing.codeEntry ? t("pairing.step2CodeTitle") : t("pairing.step2SasTitle");
  const stepTwoBody = pairing.codeEntry ? t("pairing.step2CodeBody") : t("pairing.step2SasBody");

  async function copyLink() {
    if (!pairing.qrUri) return;
    try {
      await navigator.clipboard.writeText(pairing.qrUri);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("pairing.copyFailed"));
    }
  }

  const statusText =
    pairing.step === "code" && pairing.code
      ? t(pairing.codeEntry ? "pairing.statusEnterCode" : "pairing.statusCompareCode", {
          code: `${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}`,
        })
      : pairing.step === "transferring"
        ? t("pairing.transferring")
        : pairing.step === "done"
          ? t("pairing.step3Body")
          : "";

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">{t("settings.mobile")}</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("pairing.intro")}</p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-muted-foreground">{t("pairing.getApp")}</span>
        <a
          className="underline underline-offset-2"
          href={IOS_APP_URL}
          rel="noreferrer"
          target="_blank"
        >
          {t("pairing.iphone")}
        </a>
        <a
          className="underline underline-offset-2"
          href={ANDROID_APP_URL}
          rel="noreferrer"
          target="_blank"
        >
          {t("pairing.android")}
        </a>
      </p>

      {!localIdentity ? (
        <p className="mt-6 rounded-md border bg-foreground/[0.03] px-4 py-3 text-sm leading-6">
          {t("pairing.extensionOnly")}
        </p>
      ) : (
        <div className="mt-6 flex flex-col gap-8 border-y py-6 sm:flex-row sm:items-start">
          <p aria-live="polite" className="sr-only" data-testid="pairing-status">
            {statusText}
          </p>
          <div className="flex w-full shrink-0 flex-col items-center gap-3 sm:w-64">
            <div
              className="flex min-h-64 w-64 max-w-full items-center justify-center rounded-lg border bg-background p-4 text-center"
              data-testid="pairing-panel"
            >
              {pairing.step === "idle" ? (
                <button className={PRIMARY_BUTTON} type="button" onClick={pairing.start}>
                  <Smartphone className="h-4 w-4" />
                  {t("pairing.start")}
                </button>
              ) : pairing.step === "starting" ? (
                <div className="flex flex-col items-center gap-3">
                  <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{t("pairing.starting")}</p>
                </div>
              ) : pairing.step === "qr" && pairing.qrUri ? (
                <div
                  className="rounded-md bg-white p-2"
                  data-pairing-uri={pairing.qrUri}
                  data-testid="pairing-qr"
                >
                  <QRCodeSVG
                    bgColor="#ffffff"
                    fgColor="#000000"
                    level="M"
                    marginSize={1}
                    size={208}
                    title={t("pairing.qrTitle")}
                    value={pairing.qrUri}
                  />
                </div>
              ) : pairing.step === "code" && pairing.code ? (
                <div className="flex w-full flex-col gap-5">
                  <p className="text-sm font-medium">{stepTwoTitle}</p>
                  <CodeDigits code={pairing.code} />
                  {!pairing.codeEntry ? (
                    <button className={PRIMARY_BUTTON} type="button" onClick={pairing.confirmSas}>
                      <Check className="h-4 w-4" />
                      {t("pairing.codesMatch")}
                    </button>
                  ) : null}
                </div>
              ) : pairing.step === "transferring" ? (
                <div className="flex flex-col items-center gap-3">
                  <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{t("pairing.transferring")}</p>
                </div>
              ) : pairing.step === "done" ? (
                <div className="flex flex-col items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-green-600 text-white">
                    <Check className="h-6 w-6" />
                  </span>
                  <p className="text-base font-medium">{t("pairing.done")}</p>
                </div>
              ) : pairing.step === "expired" || pairing.step === "unconfirmed" ? (
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm text-muted-foreground">
                    {pairing.step === "expired"
                      ? t("pairing.expired")
                      : t("pairing.sentUnconfirmed")}
                  </p>
                  <button className={SECONDARY_BUTTON} type="button" onClick={pairing.start}>
                    <RefreshCw className="h-4 w-4" />
                    {t("pairing.newCode")}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <TriangleAlert className="h-6 w-6 text-destructive" />
                  <p className="text-sm text-destructive">
                    {pairing.error ?? t("pairing.errorRelay")}
                  </p>
                  <button className={SECONDARY_BUTTON} type="button" onClick={pairing.start}>
                    {t("pairing.tryAgain")}
                  </button>
                </div>
              )}
            </div>
            {pairing.step === "qr" ? (
              <button className={`${SECONDARY_BUTTON} w-full`} type="button" onClick={copyLink}>
                <Copy className="h-4 w-4" />
                {t("pairing.copyLink")}
              </button>
            ) : null}
            {pairing.step === "qr" || pairing.step === "code" || pairing.step === "starting" ? (
              <button
                className={`${SECONDARY_BUTTON} w-full`}
                type="button"
                onClick={pairing.cancel}
              >
                {t("common.cancel")}
              </button>
            ) : null}
          </div>

          <ol className="flex min-w-0 flex-1 flex-col gap-5">
            <StepRow
              body={t("pairing.step1Body")}
              done={progress.scanned}
              number={1}
              title={t("pairing.step1Title")}
            />
            <StepRow body={stepTwoBody} done={progress.confirmed} number={2} title={stepTwoTitle} />
            <StepRow
              body={progress.paired ? t("pairing.step3Body") : t("pairing.step3PendingBody")}
              done={progress.paired}
              number={3}
              title={progress.paired ? t("pairing.step3Title") : t("pairing.step3PendingTitle")}
            />
          </ol>
        </div>
      )}

      {localIdentity ? (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {t("pairing.relayNote", {
            relay: pairing.relay ?? pairingRelayUrl ?? t("pairing.relayDefault"),
          })}
        </p>
      ) : null}
    </div>
  );
}
