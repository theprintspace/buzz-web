import { describe, expect, it } from "vitest";
import type { BuzzChannel, UserProfile } from "@/features/chat/lib/chat-types";
import {
  applyAppBadge,
  documentTitleFor,
  NOTIFICATION_MAX_AGE_SECONDS,
  NOTIFICATION_PREFERENCE_KEY,
  notificationPermissionState,
  notificationText,
  readNotificationPreference,
  readNotificationPrompted,
  selectNewUnreadItems,
  summaryNotificationText,
  writeNotificationPreference,
  writeNotificationPrompted,
} from "@/features/inbox/lib/browser-notifications";
import type { InboxCategory, InboxItem } from "@/features/inbox/lib/inbox-model";

const ME = "aa".repeat(32);
const ALICE = "bb".repeat(32);
const NOW = 1_800_000_000;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function item(
  id: string,
  {
    category = "mention",
    pubkey = ALICE,
    createdAt = NOW,
    unread = true,
    channelId = "general",
    content = `hello ${id}`,
  }: {
    category?: InboxCategory;
    pubkey?: string;
    createdAt?: number;
    unread?: boolean;
    channelId?: string | null;
    content?: string;
  } = {},
): InboxItem {
  return {
    id: id.repeat(64).slice(0, 64),
    category,
    channelId,
    threadRootId: null,
    unread,
    event: {
      id: id.repeat(64).slice(0, 64),
      pubkey,
      kind: 9,
      content,
      created_at: createdAt,
      tags: channelId ? [["h", channelId]] : [],
      sig: "22".repeat(64),
    },
  };
}

const channels: BuzzChannel[] = [
  {
    id: "general",
    name: "general",
    description: "",
    topic: null,
    type: "stream",
    visibility: "open",
    archived: false,
    isMember: true,
    members: [],
    participantPubkeys: [],
  },
  {
    id: "dm-1",
    name: "dm",
    description: "",
    topic: null,
    type: "dm",
    visibility: "private",
    archived: false,
    isMember: true,
    members: [],
    participantPubkeys: [ME, ALICE],
  },
];
const profiles: Record<string, UserProfile> = {
  [ALICE]: { pubkey: ALICE, name: "Alice", about: "", picture: null, isAgent: false },
};

describe("documentTitleFor", () => {
  it("prefixes the unread count and caps it at 99+", () => {
    expect(documentTitleFor("Buzz Web", 0)).toBe("Buzz Web");
    expect(documentTitleFor("Buzz Web", 3)).toBe("(3) Buzz Web");
    expect(documentTitleFor("Buzz Web", 120)).toBe("(99+) Buzz Web");
  });
});

describe("selectNewUnreadItems", () => {
  it("keeps unread, unseen, recent items from other people in time order", () => {
    const seen = new Set([item("s").id]);
    const result = selectNewUnreadItems({
      items: [
        item("b", { createdAt: NOW - 5 }),
        item("a", { createdAt: NOW - 50 }),
        item("s"),
        item("r", { unread: false }),
        item("m", { pubkey: ME }),
        item("o", { createdAt: NOW - NOTIFICATION_MAX_AGE_SECONDS - 1 }),
      ],
      seen,
      currentPubkey: ME,
      now: NOW,
    });
    expect(result.map((entry) => entry.event.content)).toEqual(["hello a", "hello b"]);
  });

  it("ignores the case of the reader's own key", () => {
    const result = selectNewUnreadItems({
      items: [item("m", { pubkey: ME.toUpperCase() })],
      seen: new Set(),
      currentPubkey: ME,
      now: NOW,
    });
    expect(result).toEqual([]);
  });
});

describe("notificationText", () => {
  it("names the sender and the channel for a mention", () => {
    expect(notificationText(item("a"), { profiles, channels })).toEqual({
      title: "Alice mentioned you in #general",
      body: "hello a",
    });
  });

  it("describes direct messages, thread replies and action requests", () => {
    expect(
      notificationText(item("a", { category: "dm", channelId: "dm-1" }), { profiles, channels })
        .title,
    ).toBe("Direct message from Alice");
    expect(notificationText(item("a", { category: "thread" }), { profiles, channels }).title).toBe(
      "Alice replied in #general",
    );
    expect(
      notificationText(item("a", { category: "thread", channelId: null }), { profiles, channels })
        .title,
    ).toBe("Alice replied to a thread");
    expect(
      notificationText(item("a", { category: "needs_action" }), { profiles, channels }).title,
    ).toBe("Alice needs your response");
  });

  it("falls back to a truncated key for unknown senders and shortens long bodies", () => {
    const text = notificationText(item("a", { content: "x".repeat(300) }), {
      profiles: {},
      channels,
    });
    expect(text.title).toBe(`${ALICE.slice(0, 8)}…${ALICE.slice(-4)} mentioned you in #general`);
    expect(text.body).toHaveLength(140);
    expect(text.body.endsWith("…")).toBe(true);
  });

  it("uses the message field of structured agent content", () => {
    const text = notificationText(
      item("a", { content: JSON.stringify({ message: "Build finished", status: "ok" }) }),
      { profiles, channels },
    );
    expect(text.body).toBe("Build finished");
  });

  it("summarises a burst of new messages", () => {
    expect(summaryNotificationText(7)).toEqual({
      title: "7 new messages in Buzz",
      body: "Open the inbox to see them.",
    });
  });
});

describe("notification preference storage", () => {
  it("round-trips the preference and the prompt flag", () => {
    const storage = new MemoryStorage();
    expect(readNotificationPreference(storage)).toBeNull();
    writeNotificationPreference(storage, "off");
    expect(readNotificationPreference(storage)).toBe("off");
    storage.setItem(NOTIFICATION_PREFERENCE_KEY, "garbage");
    expect(readNotificationPreference(storage)).toBeNull();
    expect(readNotificationPrompted(storage)).toBe(false);
    writeNotificationPrompted(storage);
    expect(readNotificationPrompted(storage)).toBe(true);
  });

  it("tolerates a missing or throwing storage", () => {
    const broken = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readNotificationPreference(null)).toBeNull();
    expect(readNotificationPreference(broken)).toBeNull();
    expect(() => writeNotificationPreference(broken, "on")).not.toThrow();
    expect(() => writeNotificationPrompted(null)).not.toThrow();
  });
});

describe("notificationPermissionState", () => {
  it("maps the browser's permission to a state", () => {
    expect(notificationPermissionState(undefined)).toBe("unsupported");
    expect(notificationPermissionState({ permission: "default" })).toBe("default");
    expect(notificationPermissionState({ permission: "granted" })).toBe("granted");
    expect(notificationPermissionState({ permission: "denied" })).toBe("denied");
    expect(notificationPermissionState({ permission: "prompt" })).toBe("default");
  });
});

describe("applyAppBadge", () => {
  it("sets the badge for unread items, clears it otherwise and survives refusal", async () => {
    const calls: string[] = [];
    const target = {
      setAppBadge: async (count?: number) => {
        calls.push(`set:${count}`);
      },
      clearAppBadge: async () => {
        calls.push("clear");
      },
    };
    await applyAppBadge(target, 4);
    await applyAppBadge(target, 0);
    expect(calls).toEqual(["set:4", "clear"]);
    await expect(
      applyAppBadge(
        {
          setAppBadge: async () => {
            throw new Error("not installed");
          },
        },
        1,
      ),
    ).resolves.toBeUndefined();
    await expect(applyAppBadge(undefined, 1)).resolves.toBeUndefined();
    await expect(applyAppBadge({}, 1)).resolves.toBeUndefined();
  });
});
