import { describe, expect, it } from "vitest";
import { findSensitive, findSensitiveFor } from "../src/safety/sensitive";

const kinds = (text: string) => findSensitive(text).map((f) => f.kind);

describe("findSensitive: cards", () => {
  it("finds a card number however it's written and names only its last four", () => {
    for (const text of [
      "My card is 4242 4242 4242 4242, exp 12/27.",
      "card 4242-4242-4242-4242",
      "4242424242424242",
      "Use 4242 4242 4242 4242 123 for the deposit",
    ]) {
      expect(findSensitive(text), text).toEqual([{ kind: "card", label: "a card number ending 4242" }]);
    }
    expect(findSensitive("Amex 3782 822463 10005")).toEqual([
      { kind: "card", label: "a card number ending 0005" },
    ]);
    expect(findSensitive("visa 4111111111111111")[0]?.label).toBe("a card number ending 1111");
    expect(findSensitive("5555 5555 5555 4444")[0]?.label).toBe("a card number ending 4444");
  });

  it("reads a card after a bare #, and with dots or no-break spaces between the groups", () => {
    for (const text of [
      "Card #4111111111111111",
      "card # 4111 1111 1111 1111",
      "4111.1111.1111.1111",
      "4111\u00a01111\u00a01111\u00a01111",
      "4111\u202f1111\u202f1111\u202f1111",
      "Amex 3782.822463.10005",
    ]) {
      expect(kinds(text), JSON.stringify(text)).toEqual(["card"]);
    }
    // Words still mark an order or invoice number.
    expect(kinds("Invoice #4111111111111111")).toEqual([]);
    expect(kinds("ref no. 4111111111111111")).toEqual([]);
  });

  it("never puts the number itself in the label", () => {
    const [f] = findSensitive("4242 4242 4242 4242");
    expect(f?.label).not.toMatch(/4242 4242|42424242/);
  });

  it("ignores numbers that fail the checksum or don't start like a card", () => {
    expect(kinds("4242 4242 4242 4241")).toEqual([]);
    expect(kinds("1234 5678 9012 3456")).toEqual([]);
    expect(kinds("9999999999999995")).toEqual([]);
  });
});

describe("findSensitive: SSN, bank, password, key, health", () => {
  it("finds a Social Security number but not invalid ones", () => {
    expect(findSensitive("SSN 123-45-6789")).toEqual([{ kind: "ssn", label: "a Social Security number" }]);
    for (const bad of ["000-12-3456", "666-12-3456", "900-12-3456", "123-00-4567", "123-45-0000"]) {
      expect(kinds(bad), bad).toEqual([]);
    }
  });

  it("finds bank details: a valid IBAN, or routing / account numbers", () => {
    for (const text of [
      "IBAN GB82 WEST 1234 5698 7654 32 THANKS",
      "Send it to DE89370400440532013000.",
      "routing number 021000021",
      "Account number: 12345678",
      "acct # 0012 3456 78",
    ]) {
      expect(findSensitive(text), text).toEqual([{ kind: "bank", label: "bank account details" }]);
    }
    expect(kinds("GB82 WEST 1234 5698 7654 33")).toEqual([]);
    expect(kinds("Check your account settings")).toEqual([]);
  });

  it("finds a password next to its value", () => {
    for (const text of [
      "password: hunter2",
      "The wifi PW: blue-fish",
      "passcode 482913",
      "PIN: 4821",
      "my password is Tr0ub4dor&3",
      "the password is 'swordfish'",
    ]) {
      expect(findSensitive(text), text).toEqual([{ kind: "password", label: "a password" }]);
    }
  });

  it("finds API keys and tokens", () => {
    // Fake keys, put together at runtime so the public-copy leak scan doesn't take them for real ones.
    const dash = "-----";
    for (const text of [
      `key: ${"sk-"}proj-abcdefghijklmnopqrstuvwx1234`,
      `${"sk-"}ant-api03-abcdefghijklmnopqrstuvwxyz`,
      `${"ghp_"}abcdefghijklmnopqrstuvwxyz0123456789`,
      `${"AKIA"}IOSFODNN7EXAMPLE`,
      `${"xoxb"}-1234567890-abcdefghij`,
      `${dash}BEGIN RSA PRIVATE KEY${dash}\nMIIE…`,
      `${dash}BEGIN PRIVATE KEY${dash}`,
    ]) {
      expect(findSensitive(text), text).toEqual([{ kind: "key", label: "an API key or token" }]);
    }
  });

  it("finds health details", () => {
    for (const text of [
      "I was diagnosed with asthma",
      "Can you pick up my prescription?",
      "She's pregnant",
      "My therapist moved the session",
      "blood test results are back",
      "He's HIV positive",
      "starting chemotherapy next week",
      "my psychiatric appointment",
    ]) {
      expect(findSensitive(text), text).toEqual([{ kind: "health", label: "a health detail" }]);
    }
  });

  it("lists each kind once, in a fixed order", () => {
    const text =
      "Card 4242 4242 4242 4242 and 4111 1111 1111 1111, SSN 123-45-6789, password: x1, my diagnosis, my medication";
    expect(kinds(text)).toEqual(["card", "ssn", "password", "health"]);
    expect(findSensitive(text)[0]?.label).toBe("a card number ending 4242");
  });
});

describe("findSensitive: no false alarms", () => {
  it("stays quiet on everyday messages", () => {
    for (const text of [
      "",
      "Call me at (555) 123-4567 or +1 415 555 2671",
      "UK office: +44 20 7946 0958",
      "Order #112-4567891-2345678 shipped",
      "Your order number 4000123412341239 is confirmed",
      "Tracking: 1Z999AA10123456784",
      "USPS 9400 1000 0000 0000 0000 00",
      "FedEx tracking 7489 2345 6712",
      "Total $1,234.56, was $1,499.00",
      "Meeting on 2026-10-28 at 10:30, back 10/31/2026",
      "Here's the password reset link: https://example.com/reset",
      "I forgot my password again",
      "My password is wrong, can you help?",
      "Use a password manager",
      "Your account is ready",
      "The skill-based task list",
      "Room 404, floor 12, confirmation code ABC123",
      "Version 1.2.3-beta, build 20261028",
    ]) {
      expect(kinds(text), text).toEqual([]);
    }
  });
});

describe("findSensitiveFor: what a category carries by design", () => {
  const text = "Card 4242 4242 4242 4242, SSN 123-45-6789, password: hunter2, my prescription";

  it("a purchase leaves out only its card", () => {
    expect(findSensitiveFor("purchase", text).map((f) => f.kind)).toEqual(["ssn", "password", "health"]);
  });

  it("a sign-in leaves out only its password and key", () => {
    const key = `${"sk-"}proj-abcdefghijklmnopqrstuvwx1234`;
    expect(findSensitiveFor("credentials", `${text} ${key}`).map((f) => f.kind)).toEqual([
      "card",
      "ssn",
      "health",
    ]);
  });

  it("other categories keep everything", () => {
    expect(findSensitiveFor("send", text).map((f) => f.kind)).toEqual(["card", "ssn", "password", "health"]);
    expect(findSensitiveFor("purchase", "Order for 2 shirts")).toEqual([]);
  });
});
