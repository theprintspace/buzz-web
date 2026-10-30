// Runs a NIP-AB source session against the pairing relay from the browser:
// opens the socket, answers an AUTH challenge with the ephemeral key, waits for
// the subscription to be live before showing the QR, feeds relay events to the
// session and keeps the spec's timers (120 s session, 30 s for `complete`).

import { useCallback, useEffect, useRef, useState } from "react";
import { relayHttpOrigin } from "@/shared/config/runtime-config";
import { t } from "@/shared/i18n";
import {
  DEFAULT_PAIRING_RELAY_URL,
  PAIRING_KIND,
  PAIRING_STEP_TIMEOUT_MS,
  PAIRING_SUBSCRIPTION_ID,
} from "./lib/nip-ab";
import {
  type PairingFailure,
  PairingSourceSession,
  type SourceAction,
} from "./lib/pairing-source-session";

export type PairingStep =
  | "idle"
  | "starting"
  | "qr"
  | "code"
  | "transferring"
  | "unconfirmed"
  | "done"
  | "expired"
  | "error";

export type PhonePairing = {
  step: PairingStep;
  qrUri: string | null;
  code: string | null;
  codeEntry: boolean;
  error: string | null;
  relay: string | null;
  start: () => void;
  confirmSas: () => void;
  cancel: () => void;
};

const EOSE_TIMEOUT_MS = 10_000;
const NIP11_TIMEOUT_MS = 5_000;

type Live = {
  session: PairingSourceSession;
  socket: WebSocket | null;
  published: Set<string>;
  timers: Set<ReturnType<typeof setTimeout>>;
};

function normalizeWsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** The community relay may advertise a dedicated pairing relay in its NIP-11 document. */
export async function discoverPairingRelay(
  relayUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NIP11_TIMEOUT_MS);
  try {
    const response = await fetcher(relayHttpOrigin(relayUrl), {
      headers: { Accept: "application/nostr+json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const info = (await response.json()) as { pairing_relay_url?: unknown };
    return normalizeWsUrl(info.pairing_relay_url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function abortReasonText(reason: string | undefined): string {
  switch (reason) {
    case "sas_mismatch":
      return t("pairing.reasonMismatch");
    case "user_denied":
      return t("pairing.reasonDenied");
    case "timeout":
      return t("pairing.reasonTimeout");
    default:
      return t("pairing.reasonProtocol");
  }
}

export function failureMessage(failure: PairingFailure, reason?: string): string {
  switch (failure) {
    case "import-failed":
      return t("pairing.errorImport");
    case "too-many-codes":
      return t("pairing.errorCodes");
    case "unsupported-version":
      return t("pairing.errorVersion");
    default:
      return t("pairing.errorStopped", { reason: abortReasonText(reason) });
  }
}

export function usePhonePairing({
  relayUrl,
  pairingRelayUrl,
  payload,
}: {
  relayUrl: string;
  pairingRelayUrl: string | null;
  /** Produces the identity payload JSON; called once, when the phone has proven itself. */
  payload: () => string;
}): PhonePairing {
  const [step, setStep] = useState<PairingStep>("idle");
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeEntry, setCodeEntry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relay, setRelay] = useState<string | null>(null);
  const liveRef = useRef<Live | null>(null);
  const generationRef = useRef(0);

  const teardown = useCallback((abort?: "user_denied" | "timeout") => {
    const live = liveRef.current;
    liveRef.current = null;
    generationRef.current += 1;
    if (!live) return;
    for (const timer of live.timers) clearTimeout(timer);
    if (abort) {
      const event = live.session.abort(abort);
      if (event && live.socket?.readyState === WebSocket.OPEN) {
        live.socket.send(JSON.stringify(["EVENT", event]));
      }
    }
    live.session.dispose();
    live.socket?.close();
  }, []);

  const fail = useCallback(
    (message: string) => {
      teardown();
      setError(message);
      setStep("error");
    },
    [teardown],
  );

  const apply = useCallback(
    (live: Live, actions: SourceAction[]) => {
      for (const action of actions) {
        switch (action.type) {
          case "publish":
            live.published.add(action.event.id);
            live.socket?.send(JSON.stringify(["EVENT", action.event]));
            break;
          case "code":
            setCode(action.code);
            setCodeEntry(action.codeEntry);
            setStep("code");
            break;
          case "payload-sent": {
            setStep("transferring");
            const timer = setTimeout(() => {
              if (liveRef.current !== live) return;
              teardown();
              setStep("unconfirmed");
            }, PAIRING_STEP_TIMEOUT_MS);
            live.timers.add(timer);
            break;
          }
          case "completed":
            teardown();
            setStep("done");
            break;
          case "failed":
            fail(failureMessage(action.failure, action.reason));
            break;
        }
      }
    },
    [fail, teardown],
  );

  const start = useCallback(() => {
    teardown();
    const generation = generationRef.current;
    setStep("starting");
    setError(null);
    setQrUri(null);
    setCode(null);
    setCodeEntry(false);

    void (async () => {
      const relayChoice =
        pairingRelayUrl ?? (await discoverPairingRelay(relayUrl)) ?? DEFAULT_PAIRING_RELAY_URL;
      if (generationRef.current !== generation) return;
      setRelay(relayChoice);

      let session: PairingSourceSession;
      try {
        session = new PairingSourceSession({ relayUrl: relayChoice, payload });
      } catch (sessionError) {
        fail(sessionError instanceof Error ? sessionError.message : t("pairing.errorRelay"));
        return;
      }
      const live: Live = { session, socket: null, published: new Set(), timers: new Set() };
      liveRef.current = live;
      const current = () => liveRef.current === live;

      let socket: WebSocket;
      try {
        socket = new WebSocket(relayChoice);
      } catch {
        fail(t("pairing.errorRelay"));
        return;
      }
      live.socket = socket;

      const eoseTimer = setTimeout(() => {
        if (current()) fail(t("pairing.errorRelay"));
      }, EOSE_TIMEOUT_MS);
      live.timers.add(eoseTimer);

      socket.onopen = () => {
        if (!current()) return;
        socket.send(
          JSON.stringify([
            "REQ",
            PAIRING_SUBSCRIPTION_ID,
            { kinds: [PAIRING_KIND], "#p": [session.pubkey] },
          ]),
        );
      };
      socket.onmessage = (message) => {
        if (!current()) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (!Array.isArray(frame)) return;
        const [type, first, second] = frame as unknown[];
        if (type === "AUTH" && typeof first === "string") {
          socket.send(JSON.stringify(["AUTH", session.signAuth(first)]));
          return;
        }
        if (type === "EOSE" && first === PAIRING_SUBSCRIPTION_ID) {
          clearTimeout(eoseTimer);
          live.timers.delete(eoseTimer);
          setQrUri(session.qrUri);
          setStep("qr");
          const expiry = setTimeout(
            () => {
              if (!current()) return;
              const sent = session.state === "payload-sent";
              teardown(sent ? undefined : "timeout");
              setStep(sent ? "unconfirmed" : "expired");
            },
            Math.max(0, session.deadline - Date.now()),
          );
          live.timers.add(expiry);
          return;
        }
        if (type === "CLOSED" && first === PAIRING_SUBSCRIPTION_ID) {
          fail(t("pairing.errorRelay"));
          return;
        }
        if (type === "OK" && typeof first === "string" && second === false) {
          if (live.published.has(first)) fail(t("pairing.errorRelay"));
          return;
        }
        if (type === "EVENT" && first === PAIRING_SUBSCRIPTION_ID) {
          apply(live, session.handleEvent(second));
        }
      };
      socket.onclose = () => {
        if (current()) fail(t("pairing.errorLost"));
      };
    })();
  }, [apply, fail, pairingRelayUrl, payload, relayUrl, teardown]);

  const confirmSas = useCallback(() => {
    const live = liveRef.current;
    if (!live) return;
    apply(live, live.session.confirmSas());
  }, [apply]);

  const cancel = useCallback(() => {
    teardown("user_denied");
    setStep("idle");
    setQrUri(null);
    setCode(null);
    setError(null);
  }, [teardown]);

  useEffect(() => () => teardown("user_denied"), [teardown]);

  return { step, qrUri, code, codeEntry, error, relay, start, confirmSas, cancel };
}
