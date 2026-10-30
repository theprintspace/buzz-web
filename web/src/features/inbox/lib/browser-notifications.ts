import type { BuzzChannel, UserProfile } from "@/features/chat/lib/chat-types";
import { type InboxItem, inboxPreview } from "@/features/inbox/lib/inbox-model";
import { t } from "@/shared/i18n";
import { truncatePubkey } from "@/shared/lib/pubkey";

export const NOTIFICATION_PREFERENCE_KEY = "buzz-web:browser-notifications";
export const NOTIFICATION_PROMPTED_KEY = "buzz-web:browser-notifications:prompted";
/** Items older than this are never announced (reconnects after a long sleep, items marked unread by hand). */
export const NOTIFICATION_MAX_AGE_SECONDS = 10 * 60;
/** More new items than this in one update collapse into a single summary notification. */
export const NOTIFICATION_BATCH_LIMIT = 3;
const BODY_LIMIT = 140;

export type NotificationPermissionState = "unsupported" | "default" | "granted" | "denied";
export type NotificationPreference = "on" | "off" | null;
export type NotificationText = { title: string; body: string };

export function readNotificationPreference(storage: Storage | null): NotificationPreference {
  try {
    const value = storage?.getItem(NOTIFICATION_PREFERENCE_KEY);
    return value === "on" || value === "off" ? value : null;
  } catch {
    return null;
  }
}

export function writeNotificationPreference(storage: Storage | null, value: "on" | "off"): void {
  try {
    storage?.setItem(NOTIFICATION_PREFERENCE_KEY, value);
  } catch {
    // Private windows and blocked storage: the preference lives for this page only.
  }
}

export function readNotificationPrompted(storage: Storage | null): boolean {
  try {
    return storage?.getItem(NOTIFICATION_PROMPTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNotificationPrompted(storage: Storage | null): void {
  try {
    storage?.setItem(NOTIFICATION_PROMPTED_KEY, "1");
  } catch {
    // Same as above: the prompt may show again in a storage-less window.
  }
}

export function notificationPermissionState(
  notification: { permission: string } | undefined,
): NotificationPermissionState {
  if (!notification) return "unsupported";
  if (notification.permission === "granted" || notification.permission === "denied") {
    return notification.permission;
  }
  return "default";
}

/** Unread items that have not been announced yet, are not the reader's own and are recent. */
export function selectNewUnreadItems({
  items,
  seen,
  currentPubkey,
  now,
}: {
  items: readonly InboxItem[];
  seen: ReadonlySet<string>;
  currentPubkey: string;
  now: number;
}): InboxItem[] {
  const own = currentPubkey.toLowerCase();
  return items
    .filter(
      (item) =>
        item.unread &&
        !seen.has(item.id) &&
        item.event.pubkey.toLowerCase() !== own &&
        now - item.event.created_at <= NOTIFICATION_MAX_AGE_SECONDS,
    )
    .sort((left, right) => left.event.created_at - right.event.created_at);
}

function senderName(pubkey: string, profiles: Readonly<Record<string, UserProfile>>): string {
  const name = profiles[pubkey]?.name.trim();
  return name || truncatePubkey(pubkey);
}

function trimBody(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > BODY_LIMIT ? `${flat.slice(0, BODY_LIMIT - 1)}…` : flat;
}

export function notificationText(
  item: InboxItem,
  {
    profiles,
    channels,
  }: {
    profiles: Readonly<Record<string, UserProfile>>;
    channels: readonly BuzzChannel[];
  },
): NotificationText {
  const name = senderName(item.event.pubkey, profiles);
  const channel = channels.find((candidate) => candidate.id === item.channelId);
  const channelName = channel && channel.type !== "dm" ? channel.name : null;
  let title: string;
  if (item.category === "dm") {
    title = t("notifications.dm", { name });
  } else if (item.category === "thread") {
    title = channelName
      ? t("notifications.thread", { name, channel: channelName })
      : t("notifications.threadNoChannel", { name });
  } else if (item.category === "needs_action") {
    title = t("notifications.needsAction", { name });
  } else {
    title = channelName
      ? t("notifications.mention", { name, channel: channelName })
      : t("notifications.mentionNoChannel", { name });
  }
  return { title, body: trimBody(inboxPreview(item.event)) };
}

export function summaryNotificationText(count: number): NotificationText {
  return {
    title: t("notifications.summary", { count }),
    body: t("notifications.summaryBody"),
  };
}

export function documentTitleFor(baseTitle: string, unreadCount: number): string {
  if (unreadCount <= 0) return baseTitle;
  return `(${unreadCount > 99 ? "99+" : unreadCount}) ${baseTitle}`;
}

type BadgeNavigator = {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Mirror the unread count on the installed app's icon where the browser supports it. */
export async function applyAppBadge(
  target: BadgeNavigator | undefined,
  count: number,
): Promise<void> {
  if (!target) return;
  try {
    if (count > 0) await target.setAppBadge?.(count);
    else await target.clearAppBadge?.();
  } catch {
    // Badging is best effort; a browser may refuse it outside an installed app.
  }
}
