import pc from "picocolors";
import { resolveAccounts } from "../config.ts";
import { JmapClient } from "../jmap.ts";
import * as ui from "../ui.ts";

interface Opts {
  account?: string;
  probe?: boolean; // --no-probe → false
}

/**
 * Show the JMAP core limits Fastmail advertises for this account and — unless
 * --no-probe — verify them with live read-only requests: a maximum-size
 * Email/query page, a maximum-size Email/get, and a request packed with
 * maxCallsInRequest method calls. This is exactly how the triage pipeline
 * sizes its bulk operations, so a passing probe means a 90k run will page
 * within what the server accepts.
 */
export async function limitsCommand(opts: Opts): Promise<void> {
  const accounts = resolveAccounts(opts.account);

  for (const account of accounts) {
    if (accounts.length > 1) ui.accountBanner(account.name);
    const jmap = new JmapClient(account.token);

    const limits = await jmap.limits();
    ui.header("JMAP core limits (advertised by server)");
    ui.table({
      head: ["Limit", "Value", "Used for"],
      colWidths: [24, 12, 40],
      rows: [
        ["maxObjectsInGet", String(limits.maxObjectsInGet), "email fetch page size"],
        ["maxObjectsInSet", String(limits.maxObjectsInSet), "bulk-move chunk size"],
        ["maxCallsInRequest", String(limits.maxCallsInRequest), "Sent-history checks per round-trip"],
        ["maxSizeRequest", `${(limits.maxSizeRequest / 1_000_000).toFixed(1)} MB`, "request body ceiling"],
        ["maxConcurrentRequests", String(limits.maxConcurrentRequests), "parallel request ceiling"],
      ],
    });

    if (opts.probe === false) continue;

    ui.header("Live probes (read-only)");
    const accountId = await jmap.primaryAccountId();

    // Probe 1: one Email/query page at the size the pipeline would use, over
    // the whole account, with calculateTotal for a volume report.
    {
      const want = Math.min(500, limits.maxObjectsInGet);
      const t0 = performance.now();
      const res = await jmap.rawCall([
        [
          "Email/query",
          {
            accountId,
            filter: {},
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: want,
            calculateTotal: true,
          },
          "q",
        ],
      ]);
      const ms = Math.round(performance.now() - t0);
      const body = res.methodResponses[0][1];
      const got = (body.ids as string[]).length;
      const total = body.total as number;
      report(
        `Email/query limit=${want}`,
        got === Math.min(want, total),
        `${got} ids in ${ms}ms — account holds ${total.toLocaleString()} emails`,
      );

      // Probe 2: Email/get at maxObjectsInGet — the largest single fetch the
      // pipeline could ever issue. Reuses ids from probe 1 (padded by a second
      // query page if needed).
      let ids = body.ids as string[];
      if (ids.length < limits.maxObjectsInGet && total > ids.length) {
        const more = await jmap.rawCall([
          [
            "Email/query",
            {
              accountId,
              filter: {},
              sort: [{ property: "receivedAt", isAscending: false }],
              position: ids.length,
              limit: limits.maxObjectsInGet - ids.length,
            },
            "q2",
          ],
        ]);
        ids = ids.concat(more.methodResponses[0][1].ids as string[]);
      }
      if (ids.length > 0) {
        const t1 = performance.now();
        const getRes = await jmap.rawCall([
          [
            "Email/get",
            {
              accountId,
              ids,
              properties: ["id", "subject", "from", "receivedAt", "preview", "keywords"],
            },
            "g",
          ],
        ]);
        const ms1 = Math.round(performance.now() - t1);
        const gotEmails = (getRes.methodResponses[0][1].list as unknown[]).length;
        const size = (JSON.stringify(getRes).length / 1_000_000).toFixed(1);
        report(
          `Email/get ${ids.length} emails (maxObjectsInGet=${limits.maxObjectsInGet})`,
          gotEmails === ids.length,
          `${gotEmails} emails, ~${size} MB response in ${ms1}ms`,
        );
      }
    }

    // Probe 3: pack a single request with maxCallsInRequest Core/echo calls —
    // validates the packing used by the Sent-history engagement check.
    {
      const n = limits.maxCallsInRequest;
      const calls = Array.from({ length: n }, (_, i) => ["Core/echo", { i }, `c${i}`]);
      const t0 = performance.now();
      const res = await jmap.rawCall(calls);
      const ms = Math.round(performance.now() - t0);
      const ok = (res.methodResponses as unknown[]).length === n;
      report(`${n} method calls in one request (maxCallsInRequest)`, ok, `${ms}ms`);
    }

    ui.info(
      pc.dim(
        "\nThe triage pipeline sizes fetch pages, bulk moves, and Sent-history " +
          "checks from these limits at runtime, so large runs stay within them.",
      ),
    );
  }
}

function report(name: string, ok: boolean, detail: string): void {
  const mark = ok ? pc.green("✓") : pc.red("✗");
  console.log(`  ${mark} ${name} — ${detail}`);
}
