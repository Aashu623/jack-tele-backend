const crypto = require("crypto");

const ALLOWED_EVENTS = new Set([
  "PageView",
  "ViewContent",
  "Lead",
  "Subscribe",
]);

const CUSTOM_DATA_KEYS = new Set([
  "value",
  "currency",
  "content_name",
  "content_category",
  "content_ids",
  "content_type",
  "predicted_ltv",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function isHashed(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function hashIfNeeded(value, normalizer) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (isHashed(trimmed)) return trimmed.toLowerCase();
  return sha256(normalizer(trimmed));
}

function normalizeEmail(value) {
  return value.toLowerCase();
}

function normalizePhone(value) {
  return value.replace(/[^\d]/g, "");
}

function asString(value, maxLength) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function looksLikeEventId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function looksLikeUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeFbp(value) {
  return typeof value === "string" && /^fb\.\d+\.\d+\.\S{1,256}$/.test(value);
}

function looksLikeFbc(value) {
  return typeof value === "string" && /^fb\.\d+\.\d+\.\S{1,512}$/.test(value);
}

function sanitizeCustomData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const customData = {};
  for (const key of CUSTOM_DATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value == null || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      customData[key] = value;
    } else if (typeof value === "string") {
      customData[key] = value.slice(0, 128);
    } else if (key === "content_ids" && Array.isArray(value)) {
      customData[key] = value
        .filter((item) => typeof item === "string" || typeof item === "number")
        .slice(0, 10)
        .map(String);
    }
  }

  return Object.keys(customData).length ? customData : undefined;
}

function buildUserData(body, requestContext) {
  const userData = {};
  const clientUser = body.user_data && typeof body.user_data === "object" ? body.user_data : {};

  if (requestContext.clientIp) {
    userData.client_ip_address = requestContext.clientIp;
  }
  if (requestContext.userAgent) {
    userData.client_user_agent = requestContext.userAgent.slice(0, 512);
  }

  const fbp = asString(body.fbp || clientUser.fbp, 256);
  const fbc = asString(body.fbc || clientUser.fbc, 512);
  if (fbp && looksLikeFbp(fbp)) userData.fbp = fbp;
  if (fbc && looksLikeFbc(fbc)) userData.fbc = fbc;

  const email = hashIfNeeded(body.email || clientUser.em, normalizeEmail);
  const phone = hashIfNeeded(body.phone || clientUser.ph, normalizePhone);
  if (email) userData.em = [email];
  if (phone) userData.ph = [phone];

  return userData;
}

function validateIncomingEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object.", status: 400 };
  }

  const eventName = asString(body.event_name, 64);
  if (!eventName || !ALLOWED_EVENTS.has(eventName)) {
    return {
      error: "event_name must be one of: PageView, ViewContent, Lead, Subscribe.",
      status: 400,
    };
  }

  const eventId = asString(body.event_id, 128);
  if (!looksLikeEventId(eventId)) {
    return {
      error: "event_id is required and must be 8-128 URL-safe characters.",
      status: 400,
    };
  }

  const eventSourceUrl = asString(body.event_source_url, 2048);
  if (eventSourceUrl && !looksLikeUrl(eventSourceUrl)) {
    return { error: "event_source_url must be a valid http(s) URL.", status: 400 };
  }

  return { eventName, eventId, eventSourceUrl };
}

function buildCapiEvent(body, requestContext) {
  const validated = validateIncomingEvent(body);
  if (validated.error) return validated;

  const userData = buildUserData(body, requestContext);
  if (!Object.keys(userData).length) {
    return {
      error: "No matchable user_data was available for this event.",
      status: 400,
    };
  }

  const event = {
    event_name: validated.eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: validated.eventId,
    action_source: "website",
    user_data: userData,
  };

  if (validated.eventSourceUrl) {
    event.event_source_url = validated.eventSourceUrl;
  }

  const customData = sanitizeCustomData(body.custom_data);
  if (customData) event.custom_data = customData;

  return { event };
}

function getGraphVersion(rawVersion) {
  const version = (rawVersion || "v21.0").trim();
  return /^v\d+\.\d+$/.test(version) ? version : "v21.0";
}

function getCapiEndpoint(pixelId, graphVersion) {
  const version = getGraphVersion(graphVersion);
  return `https://graph.facebook.com/${version}/${encodeURIComponent(pixelId)}/events`;
}

module.exports = {
  ALLOWED_EVENTS,
  buildCapiEvent,
  getCapiEndpoint,
  getGraphVersion,
  looksLikeEventId,
  sha256,
};
