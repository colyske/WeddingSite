import { constants, publicEncrypt, X509Certificate } from "node:crypto";

export const B2C_CONTRACT = "safaricom-b2c-v1";
const HOST = "https://api.safaricom.co.ke";
const COMMANDS = new Set(["BusinessPayment", "SalaryPayment", "PromotionPayment"]);

function publicOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value &&
      !url.username && !url.password && !/^(localhost|[\d[])/i.test(url.hostname);
  } catch { return false; }
}

export function providerReadiness(env = process.env) {
  const checks = {
    live: env.WEDDINGSITE_PAYMENT_MODE === "live",
    production: env.DARAJA_ENVIRONMENT === "production",
    enabled: env.DARAJA_B2C_ENABLED === "true",
    contract: env.DARAJA_B2C_API_VERSION === "v1" && env.DARAJA_B2C_CONTRACT_VERIFIED === "true",
    entitlement: env.DARAJA_B2C_CAPABILITY_CONFIRMED === "true",
    shortcode: /^\d{5,7}$/.test(env.DARAJA_B2C_SHORTCODE || "") &&
      env.DARAJA_B2C_SHORTCODE === env.DARAJA_B2C_SHORTCODE_CONFIRMED,
    command: COMMANDS.has(env.DARAJA_B2C_COMMAND_ID),
    credentials: Boolean(env.DARAJA_CONSUMER_KEY && env.DARAJA_CONSUMER_SECRET &&
      env.DARAJA_B2C_INITIATOR_NAME && env.DARAJA_B2C_INITIATOR_PASSWORD),
    certificate: Boolean(env.DARAJA_B2C_CERTIFICATE_PEM &&
      /^[a-f0-9]{64}$/i.test(env.DARAJA_B2C_CERTIFICATE_SHA256 || "")),
    callbackOrigin: publicOrigin(env.WEDDINGSITE_PUBLIC_ORIGIN)
  };
  return { ready: Object.values(checks).every(Boolean), checks };
}

export function encryptInitiatorCredential(env = process.env, now = Date.now()) {
  let cert;
  try { cert = new X509Certificate(env.DARAJA_B2C_CERTIFICATE_PEM); }
  catch { throw new Error("B2C: A valid official production X.509 certificate is required."); }
  const fingerprint = cert.fingerprint256.replaceAll(":", "").toLowerCase();
  const password = env.DARAJA_B2C_INITIATOR_PASSWORD;
  if (fingerprint !== String(env.DARAJA_B2C_CERTIFICATE_SHA256 || "").toLowerCase() ||
      cert.publicKey.asymmetricKeyType !== "rsa" || cert.publicKey.asymmetricKeyDetails.modulusLength < 2048 ||
      Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now ||
      typeof password !== "string" || !password || !/^[\x20-\x7e]+$/.test(password)) {
    throw new Error("B2C: Production certificate fingerprint, validity, RSA key or initiator credential is invalid.");
  }
  return publicEncrypt({ key: cert.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, "ascii")).toString("base64");
}

export function paymentRequest(dispatch, callbackToken, credential, env = process.env) {
  const amount = Number(dispatch.amount_minor);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount % 100 !== 0 ||
      !/^254[17]\d{8}$/.test(dispatch.msisdn || "") ||
      !/^[a-f0-9]{64}$/.test(callbackToken) ||
      !/^[0-9a-f-]{36}$/i.test(dispatch.id || "") ||
      !COMMANDS.has(dispatch.command_id) || dispatch.command_id !== env.DARAJA_B2C_COMMAND_ID ||
      dispatch.shortcode !== env.DARAJA_B2C_SHORTCODE || !publicOrigin(env.WEDDINGSITE_PUBLIC_ORIGIN)) {
    throw new Error("B2C: Invalid immutable dispatch snapshot.");
  }
  const callback = kind => `${env.WEDDINGSITE_PUBLIC_ORIGIN}/api/b2c?action=${kind}&dispatch=${dispatch.id}&token=${callbackToken}`;
  // Safaricom mpesa-node-library 678e3c33, src/endpoints/b2c.js: v1 wire contract.
  return {
    InitiatorName: env.DARAJA_B2C_INITIATOR_NAME,
    SecurityCredential: credential, CommandID: dispatch.command_id, Amount: amount / 100,
    PartyA: dispatch.shortcode, PartyB: dispatch.msisdn,
    Remarks: `Wedding ${dispatch.id.slice(0, 8)}`,
    QueueTimeOutURL: callback("timeout"), ResultURL: callback("result"), Occasion: dispatch.id
  };
}

async function jsonResponse(fetcher, url, options) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`B2C: Provider HTTP ${response.status}; reconciliation required if claimed.`);
  const text = await response.text();
  if (text.length > 32000) throw new Error("B2C: Provider response too large.");
  try { return JSON.parse(text); }
  catch { throw new Error("B2C: Provider response was not JSON."); }
}

export async function oauthToken({ env = process.env, fetcher = fetch } = {}) {
  const result = await jsonResponse(fetcher, `${HOST}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${Buffer.from(`${env.DARAJA_CONSUMER_KEY}:${env.DARAJA_CONSUMER_SECRET}`).toString("base64")}` }
  });
  if (typeof result.access_token !== "string" || !result.access_token || result.access_token.length > 8192) {
    throw new Error("B2C: OAuth response did not contain a valid access token.");
  }
  return result.access_token;
}

export async function submitPayment(request, accessToken, { env = process.env, fetcher = fetch } = {}) {
  if (!providerReadiness(env).ready) throw new Error("B2C: Provider dispatch is disabled or not configured.");
  const result = await jsonResponse(fetcher, `${HOST}/mpesa/b2c/v1/paymentrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  if (String(result.ResponseCode) !== "0" ||
      !validConversation(result.ConversationID) || !validConversation(result.OriginatorConversationID)) {
    throw new Error("B2C: Payment request not conclusively accepted; do not resend.");
  }
  return { conversation_id: result.ConversationID, originator_id: result.OriginatorConversationID };
}

export const validConversation = value =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
