// Pure helpers for processing Telegram Bot API webhook updates.
// No I/O here — all side effects live in server.js so these stay unit-testable.

/**
 * Returns true when the update represents a user who just joined a chat
 * (covers: joining via invite link, being added by an admin, unrestricted).
 */
function isMemberJoin(update) {
  const cm = update?.chat_member;
  if (!cm) return false;
  const prev = cm.old_chat_member;
  const next = cm.new_chat_member;
  if (!prev || !next) return false;
  const wasOut = prev.status === "left" || prev.status === "kicked";
  const isIn =
    next.status === "member" ||
    next.status === "administrator" ||
    next.status === "creator";
  return wasOut && isIn;
}

/**
 * Returns the Telegram user ID (number) of the member who just joined, or null.
 */
function getJoinedUserId(update) {
  const id = update?.chat_member?.new_chat_member?.user?.id;
  return typeof id === "number" ? id : null;
}

/**
 * Returns the chat/channel ID as a string (channels use negative numbers), or null.
 */
function getUpdateChannelId(update) {
  const id = update?.chat_member?.chat?.id;
  return id != null ? String(id) : null;
}

/**
 * Parses the payload from a /start <token> deep-link message.
 * Returns the token string, or null if the message is not a /start command.
 */
function parseStartToken(update) {
  const text = update?.message?.text;
  if (typeof text !== "string") return null;
  const m = text.match(/^\/start\s+(\S+)/);
  return m ? m[1] : null;
}

/**
 * Returns the Telegram user ID (number) of the message sender, or null.
 */
function getMessageUserId(update) {
  const id = update?.message?.from?.id;
  return typeof id === "number" ? id : null;
}

module.exports = {
  isMemberJoin,
  getJoinedUserId,
  getUpdateChannelId,
  parseStartToken,
  getMessageUserId,
};
