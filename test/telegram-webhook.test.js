const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isMemberJoin,
  getJoinedUserId,
  getUpdateChannelId,
  parseStartToken,
  getMessageUserId,
} = require("../lib/telegramWebhook");

// ── Fixtures ──────────────────────────────────────────────────────────────

function chatMemberUpdate(oldStatus, newStatus, { chatId = -1001234567890, userId = 111 } = {}) {
  return {
    update_id: 100,
    chat_member: {
      chat: { id: chatId, title: "Test Channel", type: "channel" },
      from: { id: 999, first_name: "Admin", is_bot: false },
      date: 1700000000,
      old_chat_member: { user: { id: userId, first_name: "John" }, status: oldStatus },
      new_chat_member: { user: { id: userId, first_name: "John" }, status: newStatus },
    },
  };
}

function startMessage(token, userId = 222333444) {
  return {
    update_id: 200,
    message: {
      message_id: 1,
      text: `/start ${token}`,
      from: { id: userId, first_name: "John", is_bot: false },
      chat: { id: userId, type: "private" },
      date: 1700000000,
    },
  };
}

// ── isMemberJoin ──────────────────────────────────────────────────────────

test("isMemberJoin: left → member = true", () => {
  assert.ok(isMemberJoin(chatMemberUpdate("left", "member")));
});

test("isMemberJoin: kicked → member = true", () => {
  assert.ok(isMemberJoin(chatMemberUpdate("kicked", "member")));
});

test("isMemberJoin: left → administrator = true", () => {
  assert.ok(isMemberJoin(chatMemberUpdate("left", "administrator")));
});

test("isMemberJoin: member → left = false (user left)", () => {
  assert.ok(!isMemberJoin(chatMemberUpdate("member", "left")));
});

test("isMemberJoin: member → kicked = false (user was kicked)", () => {
  assert.ok(!isMemberJoin(chatMemberUpdate("member", "kicked")));
});

test("isMemberJoin: member → administrator = false (role change, not a join)", () => {
  assert.ok(!isMemberJoin(chatMemberUpdate("member", "administrator")));
});

test("isMemberJoin: no chat_member key = false", () => {
  assert.ok(!isMemberJoin({ message: { text: "hello" } }));
});

test("isMemberJoin: empty object = false", () => {
  assert.ok(!isMemberJoin({}));
});

// ── getJoinedUserId ───────────────────────────────────────────────────────

test("getJoinedUserId returns new member's user ID", () => {
  const update = chatMemberUpdate("left", "member", { userId: 42 });
  assert.equal(getJoinedUserId(update), 42);
});

test("getJoinedUserId returns null for non-chat_member update", () => {
  assert.equal(getJoinedUserId({ message: {} }), null);
});

// ── getUpdateChannelId ────────────────────────────────────────────────────

test("getUpdateChannelId returns channel ID as string", () => {
  const update = chatMemberUpdate("left", "member", { chatId: -1009876543210 });
  assert.equal(getUpdateChannelId(update), "-1009876543210");
});

test("getUpdateChannelId returns null for non-chat_member update", () => {
  assert.equal(getUpdateChannelId({}), null);
});

// ── parseStartToken ───────────────────────────────────────────────────────

test("parseStartToken extracts token from /start command", () => {
  assert.equal(parseStartToken(startMessage("abc123def456")), "abc123def456");
});

test("parseStartToken handles hex tokens (32 chars)", () => {
  const token = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
  assert.equal(parseStartToken(startMessage(token)), token);
});

test("parseStartToken returns null for /start with no payload", () => {
  const update = { message: { text: "/start", from: { id: 1 } } };
  assert.equal(parseStartToken(update), null);
});

test("parseStartToken returns null for other commands", () => {
  const update = { message: { text: "/help", from: { id: 1 } } };
  assert.equal(parseStartToken(update), null);
});

test("parseStartToken returns null for chat_member update (no message)", () => {
  assert.equal(parseStartToken(chatMemberUpdate("left", "member")), null);
});

test("parseStartToken returns null for empty object", () => {
  assert.equal(parseStartToken({}), null);
});

// ── getMessageUserId ──────────────────────────────────────────────────────

test("getMessageUserId returns sender user ID", () => {
  assert.equal(getMessageUserId(startMessage("tok", 555666777)), 555666777);
});

test("getMessageUserId returns null for chat_member update", () => {
  assert.equal(getMessageUserId(chatMemberUpdate("left", "member")), null);
});
