require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { buildCapiEvent, getCapiEndpoint, isValidCurrency } = require("./lib/metaCapi");
const {
  isMemberJoin,
  getJoinedUserId,
  getUpdateChannelId,
  parseStartToken,
  getMessageUserId,
} = require("./lib/telegramWebhook");

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const PIXEL_ID = (process.env.META_PIXEL_ID || "").trim();
const ACCESS_TOKEN = (
  process.env.META_CAPI_ACCESS_TOKEN ||
  process.env.META_ACCESS_TOKEN ||
  ""
).trim();
const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v21.0";
const TEST_EVENT_CODE = (process.env.META_TEST_EVENT_CODE || "").trim();
const NODE_ENV = process.env.NODE_ENV || "development";

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
const TELEGRAM_CHANNEL_ID = (process.env.TELEGRAM_CHANNEL_ID || "").trim();
const TELEGRAM_INVITE_LINK = (process.env.TELEGRAM_INVITE_LINK || "").trim();
const SUBSCRIBE_CURRENCY_RAW = (process.env.SUBSCRIBE_CURRENCY || "USD").trim().toUpperCase();
const SUBSCRIBE_CURRENCY = isValidCurrency(SUBSCRIBE_CURRENCY_RAW) ? SUBSCRIBE_CURRENCY_RAW : null;
const SUBSCRIBE_VALUE = (() => {
  const raw = process.env.SUBSCRIBE_VALUE;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 40;

// Attribution sessions: browser identity stored between button click and bot /start.
// Map<token, { fbp, fbc, eventSourceUrl, leadEventId, clientIp, userAgent, telegramUserId, createdAt }>
const sessionStore = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of sessionStore) {
    if (v.createdAt < cutoff) sessionStore.delete(k);
  }
}, 5 * 60 * 1000).unref();

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "";
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin === "null" && NODE_ENV !== "production") {
    res.setHeader("Access-Control-Allow-Origin", "null");
  } else if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!allowedOrigins.length && NODE_ENV !== "production") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function rateLimit(req, res, next) {
  const ip = getClientIp(req) || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt > RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({ ok: false, error: "Too many requests." });
  }
  return next();
}

function logSafe(message, extra) {
  const safe = extra ? { ...extra } : undefined;
  if (safe) {
    delete safe.access_token;
    delete safe.token;
    delete safe.user_data;
    delete safe.email;
    delete safe.phone;
  }
  if (safe) {
    console.error(message, safe);
  } else {
    console.error(message);
  }
}

// Builds a Subscribe CAPI event and dispatches it to Meta.
// Used exclusively by the Telegram webhook handler after verified membership.
async function sendSubscribeEvent(eventId, capiBody, requestContext) {
  const body = { event_name: "Subscribe", event_id: eventId, ...capiBody };
  if (SUBSCRIBE_CURRENCY) {
    body.custom_data = { value: SUBSCRIBE_VALUE, currency: SUBSCRIBE_CURRENCY };
  }
  const built = buildCapiEvent(body, requestContext);
  if (built.error) {
    logSafe("Subscribe CAPI build failed after Telegram join.", { reason: built.error });
    return;
  }
  const payload = { data: [built.event], access_token: ACCESS_TOKEN };
  if (TEST_EVENT_CODE) payload.test_event_code = TEST_EVENT_CODE;
  try {
    const resp = await fetch(getCapiEndpoint(PIXEL_ID, GRAPH_VERSION), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const rb = await resp.json().catch(() => ({}));
      logSafe("Subscribe CAPI rejected.", { status: resp.status, error_type: rb.error?.type });
    }
  } catch (err) {
    logSafe("Subscribe CAPI network error.", { reason: err?.name });
  }
}

// Processes one Telegram Bot API update asynchronously (after the webhook has responded).
async function handleTelegramUpdate(update) {
  // /start <token> — user opened the bot via the attribution deep link.
  // Store their Telegram ID against the session, then deliver the channel invite link.
  const token = parseStartToken(update);
  if (token) {
    const tgUserId = getMessageUserId(update);
    const session = sessionStore.get(token);
    if (session && tgUserId != null) {
      session.telegramUserId = tgUserId;
      if (TELEGRAM_INVITE_LINK && TELEGRAM_BOT_TOKEN) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: tgUserId,
            text: "Tap below to join the channel:",
            reply_markup: {
              inline_keyboard: [[{ text: "Join Channel ✈", url: TELEGRAM_INVITE_LINK }]],
            },
          }),
        }).catch(() => {});
      }
    }
    return;
  }

  // chat_member update — user joined (or was added to) a chat.
  if (!isMemberJoin(update)) return;

  // Ignore joins to other channels/groups if TELEGRAM_CHANNEL_ID is configured.
  const channelId = getUpdateChannelId(update);
  if (TELEGRAM_CHANNEL_ID && channelId !== TELEGRAM_CHANNEL_ID) return;

  if (!PIXEL_ID || !ACCESS_TOKEN) return;

  const tgUserId = getJoinedUserId(update);

  // Find the attribution session that was linked to this Telegram user via /start.
  let session = null;
  let sessionKey = null;
  for (const [k, s] of sessionStore) {
    if (s.telegramUserId === tgUserId) {
      session = s;
      sessionKey = k;
      break;
    }
  }
  if (sessionKey) sessionStore.delete(sessionKey);

  // No session means the user joined via the direct invite link (no bot interaction).
  // We have no browser identity to attach, so we skip the Subscribe event.
  if (!session) return;

  const subscribeEventId = `sub_tg_${tgUserId}_${Date.now()}`;
  await sendSubscribeEvent(
    subscribeEventId,
    {
      event_source_url: session.eventSourceUrl,
      fbp: session.fbp,
      fbc: session.fbc,
    },
    {
      clientIp: session.clientIp,
      userAgent: session.userAgent,
    },
  );
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    pixelConfigured: Boolean(PIXEL_ID),
    tokenConfigured: Boolean(ACCESS_TOKEN),
    testEventMode: Boolean(TEST_EVENT_CODE),
    botConfigured: Boolean(TELEGRAM_BOT_TOKEN),
  });
});

// POST /api/session — called by the browser on button click before the bot redirect.
// Stores fbp/fbc and returns a short-lived token that is passed to the bot as /start payload.
app.post("/api/session", rateLimit, (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(503).json({ ok: false, error: "Bot not configured." });
  }
  const { fbp, fbc, event_source_url, event_id } = req.body || {};
  const token = crypto.randomBytes(16).toString("hex");
  sessionStore.set(token, {
    fbp: typeof fbp === "string" ? fbp.slice(0, 256) : "",
    fbc: typeof fbc === "string" ? fbc.slice(0, 2048) : "",
    eventSourceUrl: typeof event_source_url === "string" ? event_source_url.slice(0, 2048) : "",
    leadEventId: typeof event_id === "string" ? event_id.slice(0, 128) : "",
    clientIp: getClientIp(req),
    userAgent: typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].slice(0, 512)
      : "",
    telegramUserId: null,
    createdAt: Date.now(),
  });
  return res.json({ ok: true, token });
});

// POST /telegram/webhook — receives updates from the Telegram Bot API.
// Register with: https://api.telegram.org/bot<TOKEN>/setWebhook
//   ?url=https://jack-tele-backend.onrender.com/telegram/webhook
//   &secret_token=<TELEGRAM_WEBHOOK_SECRET>
//   &allowed_updates=["message","chat_member"]
app.post("/telegram/webhook", (req, res) => {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (!TELEGRAM_WEBHOOK_SECRET || secret !== TELEGRAM_WEBHOOK_SECRET) {
    return res.status(403).end();
  }
  res.status(200).end(); // Respond to Telegram before any async work
  handleTelegramUpdate(req.body).catch(() => {});
});

app.post("/api/meta/events", rateLimit, async (req, res) => {
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    logSafe("Meta CAPI is not configured: missing pixel id or access token.");
    return res.status(503).json({
      ok: false,
      error: "Server-side Meta tracking is not configured.",
    });
  }

  const requestContext = {
    clientIp: getClientIp(req),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
  };

  const built = buildCapiEvent(req.body, requestContext);
  if (built.error) {
    return res.status(built.status || 400).json({ ok: false, error: built.error });
  }

  const payload = {
    data: [built.event],
    access_token: ACCESS_TOKEN,
  };

  if (TEST_EVENT_CODE) {
    payload.test_event_code = TEST_EVENT_CODE;
  }

  const endpoint = getCapiEndpoint(PIXEL_ID, GRAPH_VERSION);

  try {
    const metaResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let metaBody = {};
    try {
      metaBody = await metaResponse.json();
    } catch {
      metaBody = {};
    }

    if (!metaResponse.ok) {
      logSafe("Meta CAPI request failed.", {
        status: metaResponse.status,
        event_name: built.event.event_name,
        event_id: built.event.event_id,
        error_type: metaBody.error?.type,
        error_code: metaBody.error?.code,
        error_subcode: metaBody.error?.error_subcode,
      });

      const status = metaResponse.status === 400 ? 502 : metaResponse.status >= 500 ? 502 : 502;
      return res.status(status).json({
        ok: false,
        error: "Meta did not accept the event.",
      });
    }

    return res.status(200).json({
      ok: true,
      event_id: built.event.event_id,
      events_received: metaBody.events_received,
    });
  } catch (error) {
    logSafe("Meta CAPI network error.", {
      event_name: built.event.event_name,
      event_id: built.event.event_id,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return res.status(502).json({ ok: false, error: "Unable to reach Meta." });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: "Invalid JSON body." });
  }
  logSafe("Unhandled server error.", { reason: err instanceof Error ? err.name : "unknown" });
  return res.status(500).json({ ok: false, error: "Internal server error." });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`jack-tele-backend listening on port ${PORT}`);
    if (TEST_EVENT_CODE) {
      const level = NODE_ENV === "production" ? "WARN" : "INFO";
      console.log(
        `[${level}] META_TEST_EVENT_CODE is set — events go to Test Events, not real conversions.` +
          (NODE_ENV === "production" ? " Remove it before going live." : ""),
      );
    }
    if (!SUBSCRIBE_CURRENCY) {
      console.log(
        "[WARN] SUBSCRIBE_CURRENCY is not set or invalid — Subscribe CAPI events will be sent without currency/value custom_data. " +
          "Set SUBSCRIBE_CURRENCY to a valid ISO 4217 code (e.g. INR, USD) to resolve the Meta Events Manager currency error.",
      );
    }
  });
}

module.exports = app;
