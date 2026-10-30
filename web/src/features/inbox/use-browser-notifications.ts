import { useCallback, useEffect, useRef, useState } from "react";
import type { BuzzChannel, UserProfile } from "@/features/chat/lib/chat-types";
import {
  applyAppBadge,
  documentTitleFor,
  NOTIFICATION_BATCH_LIMIT,
  type NotificationPermissionState,
  type NotificationText,
  notificationPermissionState,
  notificationText,
  readNotificationPreference,
  readNotificationPrompted,
  selectNewUnreadItems,
  summaryNotificationText,
  writeNotificationPreference,
  writeNotificationPrompted,
} from "@/features/inbox/lib/browser-notifications";
import type { InboxItem } from "@/features/inbox/lib/inbox-model";
import { t } from "@/shared/i18n";

export type NotificationSettings = {
  supported: boolean;
  permission: NotificationPermissionState;
  enabled: boolean;
  enable: () => Promise<boolean>;
  disable: () => void;
};

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function notificationApi(): typeof Notification | undefined {
  return typeof Notification === "undefined" ? undefined : Notification;
}

function tabIsInBackground(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState !== "visible" || !document.hasFocus();
}

/**
 * Browser notifications for new inbox items while the tab is in the background,
 * the unread count in the tab title and on the installed app's badge.
 */
export function useBrowserNotifications({
  items,
  unreadCount,
  loading,
  currentPubkey,
  profiles,
  channels,
  icon,
  onOpen,
}: {
  items: readonly InboxItem[];
  unreadCount: number;
  loading: boolean;
  currentPubkey: string;
  profiles: Readonly<Record<string, UserProfile>>;
  channels: readonly BuzzChannel[];
  icon?: string;
  onOpen: (item: InboxItem) => void;
}): NotificationSettings & { shouldPrompt: boolean; dismissPrompt: () => void } {
  const storage = safeStorage();
  const [preference, setPreference] = useState(() => readNotificationPreference(storage));
  const [permission, setPermission] = useState(() =>
    notificationPermissionState(notificationApi()),
  );
  const [prompted, setPrompted] = useState(() => readNotificationPrompted(storage));
  const supported = permission !== "unsupported";
  const enabled = permission === "granted" && preference !== "off";

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const contextRef = useRef({ profiles, channels });
  contextRef.current = { profiles, channels };
  const seenRef = useRef<Set<string> | null>(null);
  const openRef = useRef<Notification[]>([]);

  const enable = useCallback(async (): Promise<boolean> => {
    const api = notificationApi();
    setPrompted(true);
    writeNotificationPrompted(storage);
    if (!api) return false;
    try {
      await api.requestPermission();
    } catch {
      // Older Safari only takes a callback; the static permission below still tells the answer.
    }
    const result = notificationPermissionState(api);
    setPermission(result);
    if (result === "granted") {
      setPreference("on");
      writeNotificationPreference(storage, "on");
    }
    return result === "granted";
  }, [storage]);

  const disable = useCallback(() => {
    setPreference("off");
    writeNotificationPreference(storage, "off");
  }, [storage]);

  const dismissPrompt = useCallback(() => {
    setPrompted(true);
    writeNotificationPrompted(storage);
  }, [storage]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const base = t("app.title");
    document.title = documentTitleFor(base, unreadCount);
    return () => {
      document.title = base;
    };
  }, [unreadCount]);

  useEffect(() => {
    void applyAppBadge(typeof navigator === "undefined" ? undefined : navigator, unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const closeAll = () => {
      if (tabIsInBackground()) return;
      for (const notification of openRef.current) notification.close();
      openRef.current = [];
    };
    document.addEventListener("visibilitychange", closeAll);
    window.addEventListener("focus", closeAll);
    return () => {
      document.removeEventListener("visibilitychange", closeAll);
      window.removeEventListener("focus", closeAll);
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!seenRef.current) {
      seenRef.current = new Set(items.map((item) => item.id));
      return;
    }
    const seen = seenRef.current;
    const fresh = selectNewUnreadItems({
      items,
      seen,
      currentPubkey,
      now: Math.floor(Date.now() / 1000),
    });
    for (const item of items) seen.add(item.id);
    if (!fresh.length || !enabled || !tabIsInBackground()) return;
    const api = notificationApi();
    if (!api) return;

    const show = (text: NotificationText, tag: string, target: InboxItem | null) => {
      try {
        const notification = new api(text.title, { body: text.body, icon, tag });
        notification.onclick = () => {
          window.focus();
          if (target) onOpenRef.current(target);
          notification.close();
        };
        openRef.current.push(notification);
      } catch {
        // A browser may refuse to construct notifications from a page (mobile Chrome); nothing to do.
      }
    };

    if (fresh.length > NOTIFICATION_BATCH_LIMIT) {
      show(summaryNotificationText(fresh.length), "buzz-web:summary", null);
      return;
    }
    for (const item of fresh) show(notificationText(item, contextRef.current), item.id, item);
  }, [currentPubkey, enabled, icon, items, loading]);

  return {
    supported,
    permission,
    enabled,
    enable,
    disable,
    shouldPrompt: supported && permission === "default" && !prompted && !loading,
    dismissPrompt,
  };
}
