const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCapiEvent, sha256 } = require("../lib/metaCapi");

function context() {
  return {
    clientIp: "203.0.113.10",
    userAgent: "Mozilla/5.0 test",
  };
}

const VALID_FBP = "fb.1.1596403881668.1116446470";
const VALID_FBC = "fb.1.1554763741205.AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";

// ── Validation failures ────────────────────────────────────────────────────

test("rejects unknown event names", () => {
  const result = buildCapiEvent(
    { event_name: "Purchase", event_id: "evt_12345678" },
    context(),
  );
  assert.equal(result.status, 400);
  assert.match(result.error, /event_name/);
});

test("rejects missing event_id", () => {
  const result = buildCapiEvent({ event_name: "Lead" }, context());
  assert.equal(result.status, 400);
  assert.match(result.error, /event_id/);
});

test("rejects short event_id (under 8 chars)", () => {
  const result = buildCapiEvent(
    { event_name: "PageView", event_id: "short" },
    context(),
  );
  assert.equal(result.status, 400);
  assert.match(result.error, /event_id/);
});

test("rejects invalid event_source_url", () => {
  const result = buildCapiEvent(
    {
      event_name: "PageView",
      event_id: "pv_12345678",
      event_source_url: "not-a-url",
    },
    context(),
  );
  assert.equal(result.status, 400);
  assert.match(result.error, /event_source_url/);
});

test("rejects when no user_data is available at all", () => {
  // clientIp and userAgent both empty, no fbp/fbc/email/phone
  const result = buildCapiEvent(
    { event_name: "PageView", event_id: "pv_nousrdata12" },
    { clientIp: "", userAgent: "" },
  );
  assert.equal(result.status, 400);
  assert.match(result.error, /user_data/);
});

// ── Page load: PageView ────────────────────────────────────────────────────

test("builds a valid CAPI event for PageView (page load)", () => {
  const result = buildCapiEvent(
    {
      event_name: "PageView",
      event_id: "pv_1234567890ab",
      event_source_url: "https://example.com/landing",
      fbp: VALID_FBP,
    },
    context(),
  );
  assert.ok(result.event, "expected event, got error: " + result.error);
  assert.equal(result.event.event_name, "PageView");
  assert.equal(result.event.event_id, "pv_1234567890ab");
  assert.equal(result.event.action_source, "website");
  assert.equal(result.event.event_source_url, "https://example.com/landing");
  assert.equal(result.event.user_data.fbp, VALID_FBP);
  assert.equal(result.event.user_data.client_ip_address, "203.0.113.10");
});

test("PageView succeeds with only IP and user-agent (no fbp/fbc/email)", () => {
  const result = buildCapiEvent(
    { event_name: "PageView", event_id: "pv_iponlyxyzab" },
    context(),
  );
  assert.ok(result.event);
  assert.equal(result.event.user_data.client_ip_address, "203.0.113.10");
  assert.equal(result.event.user_data.client_user_agent, "Mozilla/5.0 test");
  assert.ok(!result.event.user_data.fbp);
});

// ── Button click: Lead ────────────────────────────────────────────────────
//
// Clicking "Join Telegram" is recorded as a Lead event, NOT Subscribe.
// A redirect to t.me proves only intent; the backend has no Telegram bot
// webhook to verify that the user actually joined the channel.

test("builds a valid CAPI event for Lead (Telegram button click)", () => {
  const result = buildCapiEvent(
    {
      event_name: "Lead",
      event_id: "lead_abcdef1234",
      event_source_url: "https://example.com/landing",
      fbp: VALID_FBP,
    },
    context(),
  );
  assert.ok(result.event);
  assert.equal(result.event.event_name, "Lead");
  assert.equal(result.event.event_id, "lead_abcdef1234");
  assert.equal(result.event.user_data.fbp, VALID_FBP);
});

test("builds a valid Lead event with hashed email and fbp", () => {
  const result = buildCapiEvent(
    {
      event_name: "Lead",
      event_id: "lead_abc-12345",
      event_source_url: "https://example.com/",
      fbp: VALID_FBP,
      email: "  Test.User@Example.com ",
      custom_data: { currency: "USD", value: "0.00", secret: "drop-me" },
    },
    context(),
  );

  assert.ok(result.event);
  assert.equal(result.event.event_name, "Lead");
  assert.equal(result.event.event_id, "lead_abc-12345");
  assert.equal(result.event.action_source, "website");
  assert.equal(result.event.event_source_url, "https://example.com/");
  assert.equal(result.event.user_data.fbp, VALID_FBP);
  assert.equal(result.event.user_data.client_ip_address, "203.0.113.10");
  assert.equal(result.event.user_data.em[0], sha256("test.user@example.com"));
  assert.equal(result.event.custom_data.currency, "USD");
  assert.equal(result.event.custom_data.secret, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(result.event.user_data, "em_plain"));
});

// ── Verified subscription: Subscribe ──────────────────────────────────────
//
// Subscribe MUST NOT be sent from the browser on button click.
// It is reserved for a future server-side flow where a Telegram bot webhook
// (chat_member update) confirms the user actually joined the channel.
// The event is kept in ALLOWED_EVENTS so the backend can accept it once
// that verification path is built; it must never be called from the frontend.

test("Subscribe event builds correctly (for future server-side verified use only)", () => {
  const result = buildCapiEvent(
    {
      event_name: "Subscribe",
      event_id: "sub_12345678abcd",
      event_source_url: "https://example.com/landing",
      fbp: VALID_FBP,
    },
    context(),
  );
  assert.ok(result.event);
  assert.equal(result.event.event_name, "Subscribe");
  assert.equal(result.event.event_id, "sub_12345678abcd");
});

// ── Deduplication ─────────────────────────────────────────────────────────
//
// The browser pixel and CAPI must use the same event_id so Meta can
// deduplicate. Our backend forwards the id unchanged; Meta's servers
// do the actual deduplication.

test("event_id is preserved unchanged for browser↔CAPI deduplication", () => {
  const fixedId = "dedup_test_id_1234";
  const result = buildCapiEvent(
    { event_name: "Lead", event_id: fixedId, fbp: VALID_FBP },
    context(),
  );
  assert.ok(result.event);
  assert.equal(result.event.event_id, fixedId);
});

test("second request with same event_id is accepted (Meta handles dedup)", () => {
  const sharedId = "evt_shared_1234ab";
  const opts = { event_name: "Lead", event_id: sharedId, fbp: VALID_FBP };
  const first = buildCapiEvent(opts, context());
  const second = buildCapiEvent(opts, context());
  assert.ok(first.event);
  assert.ok(second.event);
  assert.equal(first.event.event_id, sharedId);
  assert.equal(second.event.event_id, sharedId);
});

// ── FBP / FBC passthrough ─────────────────────────────────────────────────

test("does not hash fbp or fbc", () => {
  const result = buildCapiEvent(
    { event_name: "PageView", event_id: "pv_12345678", fbp: VALID_FBP, fbc: VALID_FBC },
    context(),
  );
  assert.equal(result.event.user_data.fbp, VALID_FBP);
  assert.equal(result.event.user_data.fbc, VALID_FBC);
});

test("ignores malformed fbp", () => {
  const result = buildCapiEvent(
    { event_name: "PageView", event_id: "pv_badfbp1234", fbp: "not-valid-fbp" },
    context(),
  );
  assert.ok(result.event);
  assert.ok(!result.event.user_data.fbp);
});

// ── Custom data sanitization ──────────────────────────────────────────────

test("strips unknown custom_data keys", () => {
  const result = buildCapiEvent(
    {
      event_name: "Lead",
      event_id: "lead_sanitize12",
      fbp: VALID_FBP,
      custom_data: { value: 9.99, currency: "USD", secret: "drop-me", injected: "bad" },
    },
    context(),
  );
  assert.ok(result.event);
  assert.equal(result.event.custom_data.value, 9.99);
  assert.equal(result.event.custom_data.currency, "USD");
  assert.equal(result.event.custom_data.secret, undefined);
  assert.equal(result.event.custom_data.injected, undefined);
});
