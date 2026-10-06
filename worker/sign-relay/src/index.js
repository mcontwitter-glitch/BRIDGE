/**
 * Cloudflare Worker: POST /api/sign-relay
 * Body: { txHash, srcChainId }
 * Secret: BRIDGE_RELAY_SIGNER_PK
 */
import { signLockTransaction } from "./sign.js";

const ALLOWED_ORIGINS = new Set(["https://bridge.bigfoot404.biz"]);
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
/** @type {Map<string, { count: number, reset: number }>} */
const rateBuckets = new Map();

function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

// Any page may ask: the signer only signs packets that match a real on-chain
// assignJob record, so origin checks add no safety and broke some mobile wallet
// browsers ("Load failed"). Rate limiting still applies.
function corsHeaders(origin) {
  const allow = "*";
  /** @type {Record<string, string>} */
  const headers = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (allow) headers["access-control-allow-origin"] = allow;
  return headers;
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function rateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.reset) {
    bucket = { count: 0, reset: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  // Bound memory on the isolate
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now >= v.reset) rateBuckets.delete(k);
    }
  }
  return bucket.count <= RATE_MAX;
}

function redact(err) {
  return String(err?.message || err).replace(/0x[a-fA-F0-9]{64}/g, "0x…");
}

function pathOk(pathname) {
  return pathname === "/api/sign-relay" || pathname === "/api/sign-relay/";
}

export default {
  /**
   * @param {Request} request
   * @param {{ BRIDGE_RELAY_SIGNER_PK?: string }} env
   */
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      const headers = corsHeaders(origin);
      if (!headers["access-control-allow-origin"]) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST") {
      return json(405, { error: "method not allowed" }, origin);
    }
    if (!pathOk(url.pathname)) {
      return json(404, { error: "not found" }, origin);
    }
    if (!rateLimit(clientIp(request))) {
      return json(429, { error: "rate limit exceeded" }, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "invalid json" }, origin);
    }
    const txHash = body?.txHash;
    const srcChainId = body?.srcChainId;
    const packetIndex = body?.packetIndex ?? 0;
    if (!txHash || srcChainId === undefined || srcChainId === null) {
      return json(400, { error: "txHash and srcChainId are required" }, origin);
    }
    if (!env?.BRIDGE_RELAY_SIGNER_PK) {
      return json(500, { error: "signer is not configured" }, origin);
    }

    try {
      const result = await signLockTransaction({
        txHash,
        srcChainId,
        packetIndex,
        privateKey: env.BRIDGE_RELAY_SIGNER_PK,
      });
      return json(
        200,
        {
          encodedPacket: result.encodedPacket,
          signature: result.signature,
          dstChainId: result.dstChainId,
          verifier: result.verifier,
        },
        origin,
      );
    } catch (err) {
      const message = redact(err);
      const status = /not found|could not be found|unsupported|must be|required|match|did not|PacketSent|assignJob/i.test(message)
        ? 400
        : 502;
      return json(status, { error: message }, origin);
    }
  },
};

export { corsHeaders, rateLimit, pathOk, isLocalOrigin };
