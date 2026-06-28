/**
 * Unsubscribe execution: classify the method a sender offers (RFC 2369/8058)
 * and carry it out.
 *
 *  - one-click: HTTPS POST per RFC 8058 (sender opted in via List-Unsubscribe-Post)
 *  - email:     send a message to the mailto: unsubscribe address
 *  - manual:    only an HTTPS link with no one-click — must be opened in a browser
 *  - none:      no List-Unsubscribe header present
 */

import { FastmailEngine } from "./fastmail.ts";

export type Method = "one-click" | "email" | "manual" | "none";

export interface SenderUnsub {
  senderEmail: string;
  senderName: string;
  count: number; // how many messages from this sender in the batch
  method: Method;
  target: string; // URL or mailto used for the method
}

interface RawInfo {
  senderEmail: string;
  senderName: string;
  urls: string[];
  oneClick: boolean;
}

function classify(urls: string[], oneClick: boolean): { method: Method; target: string } {
  const https = urls.find((u) => u.toLowerCase().startsWith("https:"));
  const mailto = urls.find((u) => u.toLowerCase().startsWith("mailto:"));
  if (https && oneClick) return { method: "one-click", target: https };
  if (mailto) return { method: "email", target: mailto };
  if (https) return { method: "manual", target: https };
  return { method: "none", target: "" };
}

/** Collapse per-email unsubscribe info into one row per sender. */
export function groupBySender(infos: RawInfo[]): SenderUnsub[] {
  const bySender = new Map<string, SenderUnsub>();
  for (const info of infos) {
    const key = info.senderEmail.toLowerCase();
    if (!key) continue;
    const { method, target } = classify(info.urls, info.oneClick);
    const existing = bySender.get(key);
    if (existing) {
      existing.count++;
      // Upgrade to the most automatable method we've seen for this sender.
      if (rank(method) > rank(existing.method)) {
        existing.method = method;
        existing.target = target;
      }
    } else {
      bySender.set(key, {
        senderEmail: info.senderEmail,
        senderName: info.senderName,
        count: 1,
        method,
        target,
      });
    }
  }
  return [...bySender.values()].sort((a, b) => b.count - a.count);
}

function rank(m: Method): number {
  return { "one-click": 3, email: 2, manual: 1, none: 0 }[m];
}

export interface UnsubResult {
  sender: SenderUnsub;
  ok: boolean;
  detail: string;
}

/** Parse a mailto: URL into address + optional subject/body. */
function parseMailto(mailto: string): { to: string; subject: string; body: string } {
  const withoutScheme = mailto.slice("mailto:".length);
  const [addr = "", query = ""] = withoutScheme.split("?");
  const params = new URLSearchParams(query);
  return {
    to: decodeURIComponent(addr),
    subject: params.get("subject") || "unsubscribe",
    body: params.get("body") || "Please unsubscribe me from this list.",
  };
}

/** Execute the unsubscribe for one sender. Only acts on automatable methods. */
export async function executeUnsub(
  sender: SenderUnsub,
  engine: FastmailEngine,
): Promise<UnsubResult> {
  try {
    if (sender.method === "one-click") {
      const resp = await fetch(sender.target, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      return {
        sender,
        ok: resp.ok,
        detail: resp.ok ? `POST ${resp.status}` : `POST failed ${resp.status}`,
      };
    }
    if (sender.method === "email") {
      const { to, subject, body } = parseMailto(sender.target);
      await engine.send({ to, subject, body });
      return { sender, ok: true, detail: `emailed ${to}` };
    }
    if (sender.method === "manual") {
      return { sender, ok: false, detail: `open in browser: ${sender.target}` };
    }
    return { sender, ok: false, detail: "no List-Unsubscribe header" };
  } catch (err) {
    return { sender, ok: false, detail: (err as Error).message };
  }
}
