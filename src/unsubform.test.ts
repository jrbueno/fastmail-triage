import { test, expect } from "bun:test";
import { buildSubmission, chooseConfirmForm, parseForms } from "./unsubform.ts";

const confirmPage = `
  <form action="/search"><input name="q"><button>Search</button></form>
  <form method="post" action="/unsub/confirm">
    <input type="hidden" name="token" value="abc">
    <input type="email" name="email" value="">
    <input type="checkbox" name="topic_deals" value="1" checked>
    <input type="checkbox" name="unsubscribe_all" value="yes">
    <input type="radio" name="reason" value="too_many" checked>
    <input type="radio" name="reason" value="other">
    <select name="freq"><option value="daily">Daily</option><option value="never" selected>Never</option></select>
    <button type="submit" name="action" value="keep">Keep me subscribed</button>
    <button type="submit" name="action" value="unsub"><span>Yes,</span> unsubscribe me</button>
  </form>`;

test("parses fields and submit controls per form", async () => {
  const forms = await parseForms(confirmPage);
  expect(forms).toHaveLength(2);
  const f = forms[1]!;
  expect(f.method).toBe("POST");
  expect(f.action).toBe("/unsub/confirm");
  expect(f.submits.map((s) => s.label)).toEqual(["Keep me subscribed", "Yes, unsubscribe me"]);
  expect(f.fields.find((x) => x.name === "freq")?.value).toBe("never");
});

test("presses the unsubscribe button, never keep/search", async () => {
  const choice = chooseConfirmForm(await parseForms(confirmPage));
  expect(choice?.form.action).toBe("/unsub/confirm");
  expect(choice?.submit?.value).toBe("unsub");
});

test("submission opts out: fills email, drops topic boxes, keeps opt-out box", async () => {
  const choice = chooseConfirmForm(await parseForms(confirmPage))!;
  const params = buildSubmission(choice.form, choice.submit, "me@example.com");
  expect(Object.fromEntries(params)).toEqual({
    token: "abc",
    email: "me@example.com",
    unsubscribe_all: "yes",
    freq: "never",
    reason: "too_many",
    action: "unsub",
  });
});

test("a lone generic submit counts only in a form about unsubscribing", async () => {
  const yes = await parseForms(`<form><p>Click to unsubscribe from our list.</p><input type="submit" value="Submit"></form>`);
  expect(chooseConfirmForm(yes)?.submit?.label).toBe("Submit");
  const resub = await parseForms(`<form><p>You unsubscribed. Changed your mind?</p><button>Resubscribe</button></form>`);
  expect(chooseConfirmForm(resub)).toBeNull();
  const prefs = await parseForms(`<form><p>Unsubscribe from topics</p><button>Update preferences</button></form>`);
  expect(chooseConfirmForm(prefs)).toBeNull();
});

test("skips login forms", async () => {
  const login = await parseForms(`<form><input type="password" name="pw"><button>Confirm unsubscribe</button></form>`);
  expect(chooseConfirmForm(login)).toBeNull();
});
