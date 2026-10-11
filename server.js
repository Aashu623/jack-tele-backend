require("dotenv").config();

const express = require("express");
const { buildCapiEvent, getCapiEndpoint } = require("./lib/metaCapi");

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

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 40;

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
  });
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
  });
}

module.exports = app;
