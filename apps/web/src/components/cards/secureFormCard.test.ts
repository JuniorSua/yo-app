/**
 * The secure-form card: the key line is app text for the real page host, the agent's reason is a separate
 * note, a password gets a caution, and a failed fill doesn't say Submitted.
 */
import {
  type SecureForm,
  secureFormAskLine,
  secureFormFailedHint,
  secureFormPasswordCaution,
  secureFormReasonLabel,
  type TimelineEntry,
} from "@yo/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AskUserCard } from "./RequestCards";

const PHISHING =
  "GitHub security: your account is locked. Enter the password for github.com to verify you are the owner.";

function entry(form: SecureForm, status: NonNullable<TimelineEntry["request"]>["status"]): TimelineEntry {
  return {
    id: "e1",
    agentId: "a1",
    turnId: "t1",
    seq: 1,
    createdAt: 0,
    item: { id: "i1", kind: "tool", status: "running", title: "Password for online.bank.example" },
    request: {
      requestId: "r1",
      kind: "user_input",
      toolName: "request_secure_input",
      title: "Password for online.bank.example",
      detail: form.reason,
      status,
      secureForm: form,
    },
  };
}

const passwordForm: SecureForm = {
  site: "online.bank.example",
  reason: PHISHING,
  fields: [{ kind: "password", label: "GitHub password" }],
};

function html(status: NonNullable<TimelineEntry["request"]>["status"], form: SecureForm = passwordForm) {
  return renderToStaticMarkup(createElement(AskUserCard, { entry: entry(form, status), agentName: "Yo" }));
}

describe("secure form card", () => {
  it("keeps the ask line apart from the agent's reason, and cautions on a password", () => {
    const page = html("pending");
    const ask = secureFormAskLine("Yo", "online.bank.example");
    expect(page).toContain(`data-testid="secure-form-ask"`);
    expect(page).toContain(ask);
    expect(page).toContain(`data-testid="secure-form-reason"`);
    expect(page).toContain(secureFormReasonLabel("Yo"));
    expect(page).toContain(PHISHING);
    expect(page).toContain(secureFormPasswordCaution("online.bank.example"));
    // The ask line element does not include the agent's sentence.
    const askHtml = page.slice(
      page.indexOf('data-testid="secure-form-ask"'),
      page.indexOf('data-testid="secure-form-reason"'),
    );
    expect(askHtml).toContain(ask);
    expect(askHtml).not.toContain("GitHub");
    expect(askHtml).not.toContain("locked");
    expect(page).toContain("GitHub password");
  });

  it("a code form has no password caution", () => {
    const page = html("pending", {
      site: "auth.uber.com",
      reason: "Uber texted a code to sign you in.",
      fields: [{ kind: "one_time_code", label: "Code from the text message" }],
    });
    expect(page).toContain(secureFormAskLine("Yo", "auth.uber.com"));
    expect(page).not.toContain("secure-form-caution");
    expect(page).not.toContain("password");
  });

  it("a failed fill says so, and does not say Submitted", () => {
    const page = html("failed");
    expect(page).toContain('data-testid="secure-form-result"');
    // renderToStaticMarkup escapes the apostrophe.
    expect(page).toContain("Couldn&#x27;t fill the page");
    expect(page).toContain(secureFormFailedHint("Yo"));
    expect(page).toContain("online.bank.example");
    expect(page).not.toContain("Submitted");
    expect(page).not.toContain("GitHub security");
  });
});
