/**
 * Following a body unsubscribe link like a minimal browser: GET it (keeping
 * cookies across redirects and meta refreshes), and when the landing page is a
 * "confirm your unsubscribe" form, fill it in and submit it.
 *
 * Form choice is conservative: the submit control must read as unsubscribe /
 * opt-out / confirm, and anything reading as resubscribe, cancel, keep, or
 * update-preferences is never pressed. Any page still showing a form or
 * button after that is reported for a browser.
 */

export interface FormField {
  kind: "hidden" | "text" | "email" | "checkbox" | "radio" | "select" | "textarea";
  name: string;
  value: string;
  checked: boolean;
}

export interface SubmitControl {
  name: string | null;
  value: string;
  label: string;
}

export interface ParsedForm {
  action: string;
  method: "GET" | "POST";
  fields: FormField[];
  submits: SubmitControl[];
  text: string; // all text inside the form, for context
  hasPassword: boolean;
}

const POSITIVE = /unsubscribe|opt[\s-]?out|confirm|remove me|\byes\b/i;
const NEGATIVE =
  /re-?subscribe|subscribe again|stay subscribed|keep (?:me|my)|cancel|undo|go back|no,? (?:thanks|keep)|(?:update|save|manage) (?:my |your )?(?:email )?preferences|log ?in|sign ?in|search/i;
// Checkbox / radio values that mean "take me off" rather than "keep this topic".
const OPT_OUT_VALUE = /unsub|opt.?out|\ball\b|confirm/i;

/** Parse every <form> in a page into its fields and submit controls. */
export async function parseForms(html: string): Promise<ParsedForm[]> {
  const forms: ParsedForm[] = [];
  let form: ParsedForm | null = null;
  let select: FormField | null = null;
  let firstOption: string | null = null;
  let submit: SubmitControl | null = null;

  await new HTMLRewriter()
    .on("form", {
      element(el) {
        const f: ParsedForm = {
          action: el.getAttribute("action") ?? "",
          method: el.getAttribute("method")?.toUpperCase() === "POST" ? "POST" : "GET",
          fields: [],
          submits: [],
          text: "",
          hasPassword: false,
        };
        form = f;
        el.onEndTag(() => {
          forms.push(f);
          form = null;
        });
      },
      text(t) {
        if (form) form.text += t.text;
      },
    })
    .on("input", {
      element(el) {
        if (!form) return;
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        const name = el.getAttribute("name");
        const value = el.getAttribute("value") ?? "";
        if (type === "password") form.hasPassword = true;
        if (type === "submit" || type === "image") {
          form.submits.push({ name, value, label: value });
          return;
        }
        if (!name || el.hasAttribute("disabled")) return;
        const kind = (["hidden", "email", "checkbox", "radio"] as const).find((k) => k === type) ?? "text";
        form.fields.push({ kind, name, value: kind === "checkbox" || kind === "radio" ? value || "on" : value, checked: el.hasAttribute("checked") });
      },
    })
    .on("textarea", {
      element(el) {
        const name = el.getAttribute("name");
        if (form && name) form.fields.push({ kind: "textarea", name, value: "", checked: false });
      },
    })
    .on("select", {
      element(el) {
        const name = el.getAttribute("name");
        if (!form || !name) return;
        const s: FormField = { kind: "select", name, value: "", checked: false };
        select = s;
        firstOption = null;
        el.onEndTag(() => {
          if (!s.checked) s.value = firstOption ?? "";
          form?.fields.push(s);
          select = null;
        });
      },
    })
    .on("option", {
      element(el) {
        if (!select) return;
        const value = el.getAttribute("value") ?? "";
        firstOption ??= value;
        if (el.hasAttribute("selected")) {
          select.value = value;
          select.checked = true;
        }
      },
    })
    .on("button", {
      element(el) {
        if (!form) return;
        const type = (el.getAttribute("type") ?? "submit").toLowerCase();
        if (type !== "submit") return;
        const s: SubmitControl = { name: el.getAttribute("name"), value: el.getAttribute("value") ?? "", label: "" };
        submit = s;
        form.submits.push(s);
        el.onEndTag(() => {
          submit = null;
        });
      },
      text(t) {
        if (submit) submit.label += t.text;
      },
    })
    .transform(new Response(html))
    .text();

  for (const f of forms) {
    f.text = f.text.replace(/\s+/g, " ").trim();
    for (const s of f.submits) s.label = s.label.replace(/\s+/g, " ").trim() || s.value;
  }
  return forms;
}

/**
 * Pick the form + submit control that confirms an unsubscribe, or null.
 * A control that says unsubscribe/confirm wins; a lone generic "Submit" is
 * accepted only when the form itself talks about unsubscribing.
 */
export function chooseConfirmForm(forms: ParsedForm[]): { form: ParsedForm; submit: SubmitControl | null } | null {
  for (const form of forms) {
    if (form.hasPassword) continue;
    const named = form.submits.find((s) => POSITIVE.test(s.label) && !NEGATIVE.test(s.label));
    if (named) return { form, submit: named };
    const lone = form.submits.length <= 1 ? (form.submits[0] ?? null) : undefined;
    if (
      lone !== undefined &&
      !(lone && NEGATIVE.test(lone.label)) &&
      /unsubscribe|opt[\s-]?out/i.test(form.text) &&
      !/re-?subscribe/i.test(form.text)
    ) {
      return { form, submit: lone };
    }
  }
  return null;
}

/**
 * The values a browser would send, steered toward opting out: topic
 * checkboxes are left unticked unless they read as opt-out, radios prefer an
 * opt-out choice, and an empty email field gets the recipient's address.
 */
export function buildSubmission(form: ParsedForm, submit: SubmitControl | null, recipient: string): URLSearchParams {
  const params = new URLSearchParams();
  const radios = new Map<string, FormField[]>();
  for (const f of form.fields) {
    if (f.kind === "checkbox") {
      if (OPT_OUT_VALUE.test(`${f.name} ${f.value}`)) params.append(f.name, f.value);
    } else if (f.kind === "radio") {
      radios.set(f.name, [...(radios.get(f.name) ?? []), f]);
    } else if (!f.value && recipient && (f.kind === "email" || /e-?mail/i.test(f.name))) {
      params.append(f.name, recipient);
    } else {
      params.append(f.name, f.value);
    }
  }
  for (const [name, group] of radios) {
    const pick = group.find((r) => OPT_OUT_VALUE.test(r.value)) ?? group.find((r) => r.checked);
    if (pick) params.append(name, pick.value);
  }
  if (submit?.name) params.append(submit.name, submit.value);
  return params;
}

interface Page {
  url: string;
  status: number;
  html: string;
}

/** fetch with per-host cookies, manual redirects, and meta-refresh following. */
class Session {
  private cookies = new Map<string, Map<string, string>>();

  private cookieHeader(url: URL): string {
    return [...(this.cookies.get(url.host) ?? [])].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private store(url: URL, headers: Headers): void {
    for (const c of headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const jar = this.cookies.get(url.host) ?? new Map<string, string>();
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      this.cookies.set(url.host, jar);
    }
  }

  async load(start: string, init: { method: "GET" | "POST"; body?: string } = { method: "GET" }): Promise<Page> {
    let url = new URL(start);
    let { method, body } = init;
    for (let hop = 0; hop < 12; hop++) {
      if (url.protocol !== "https:") throw new Error(`refusing non-HTTPS hop: ${url}`);
      const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0", Accept: "text/html,*/*" };
      const cookie = this.cookieHeader(url);
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
      const resp = await fetch(url, { method, body, headers, redirect: "manual" });
      this.store(url, resp.headers);
      const location = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && location) {
        url = new URL(location, url);
        if (resp.status !== 307 && resp.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const html = await resp.text();
      const refresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=['"]?([^"'>\s]+)/i);
      if (resp.ok && refresh) {
        url = new URL(refresh[1]!.replace(/&amp;/g, "&"), url);
        method = "GET";
        body = undefined;
        continue;
      }
      return { url: url.toString(), status: resp.status, html };
    }
    throw new Error("too many redirects");
  }

  submit(page: Page, form: ParsedForm, params: URLSearchParams): Promise<Page> {
    const action = new URL(form.action || page.url, page.url);
    if (form.method === "POST") return this.load(action.toString(), { method: "POST", body: params.toString() });
    action.search = params.toString();
    return this.load(action.toString());
  }
}

/** How many confirmation steps to click through before giving up. */
const MAX_CONFIRM_STEPS = 2;

/**
 * Open a body unsubscribe link and click through any confirmation form.
 * Succeeds only when the final page has no form or button left — even a
 * "you're unsubscribed" page with a leftover form fails, so it can be checked
 * by hand.
 */
export async function followUnsubLink(url: string, recipient: string): Promise<{ ok: boolean; detail: string }> {
  const session = new Session();
  const steps: string[] = [];
  try {
    let page = await session.load(url);
    steps.push(`GET ${page.status}`);
    for (let i = 0; i < MAX_CONFIRM_STEPS && page.status < 400; i++) {
      const choice = chooseConfirmForm(await parseForms(page.html));
      if (!choice) break;
      page = await session.submit(page, choice.form, buildSubmission(choice.form, choice.submit, recipient));
      steps.push(`"${choice.submit?.label || "submit"}" ${choice.form.method} ${page.status}`);
    }
    const trail = `body link ${steps.join(" → ")}`;
    if (page.status >= 400) return { ok: false, detail: `${trail}: ${url}` };
    if (/<form\b|<button\b/i.test(page.html)) {
      return { ok: false, detail: `${trail}, page still has a form — open in browser: ${url}` };
    }
    return { ok: true, detail: trail };
  } catch (err) {
    return { ok: false, detail: `body link: ${(err as Error).message}` };
  }
}
