const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCapiEvent, sha256 } = require("../lib/metaCapi");

function context() {
  return {
    clientIp: "203.0.113.10",
    userAgent: "Mozilla/5.0 test",
  };
}

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

test("builds a valid CAPI event with fbp and hashed email", () => {
  const result = buildCapiEvent(
    {
      event_name: "Lead",
      event_id: "lead_abc-12345",
      event_source_url: "https://example.com/",
      fbp: "fb.1.1596403881668.1116446470",
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
  assert.equal(result.event.user_data.fbp, "fb.1.1596403881668.1116446470");
  assert.equal(result.event.user_data.client_ip_address, "203.0.113.10");
  assert.equal(result.event.user_data.em[0], sha256("test.user@example.com"));
  assert.equal(result.event.custom_data.currency, "USD");
  assert.equal(result.event.custom_data.secret, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(result.event.user_data, "em_plain"));
});

test("does not hash fbp or fbc", () => {
  const fbp = "fb.1.1596403881668.1116446470";
  const fbc = "fb.1.1554763741205.AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";
  const result = buildCapiEvent(
    {
      event_name: "PageView",
      event_id: "pv_12345678",
      fbp,
      fbc,
    },
    context(),
  );
  assert.equal(result.event.user_data.fbp, fbp);
  assert.equal(result.event.user_data.fbc, fbc);
});
