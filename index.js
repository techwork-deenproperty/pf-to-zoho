import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import axiosRetry from "axios-retry";

dotenv.config();

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      error.response?.status === 429 ||
      error.response?.status >= 500
    );
  },
});

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Server is running");
});

const requiredEnvVars = [
  "PF_API_KEY",
  "PF_API_SECRET",
  "WEBHOOK_URL",
  "WEBHOOK_SECRET",
  "ZOHO_CLIENT_ID",
  "ZOHO_CLIENT_SECRET",
  "ZOHO_REFRESH_TOKEN",
];

const missing = requiredEnvVars.filter((v) => !process.env[v]);
if (missing.length) {
  console.error("❌ Missing ENV vars:", missing.join(", "));
  process.exit(1);
}

const tokenCache = {
  pf: { token: null, expiresAt: 0 },
  zoho: { token: null, expiresAt: 0 },
};

const processedLeads = new Set();
const LEAD_CACHE_SIZE = 1000;

function parseFullName(name) {
  if (!name) return { firstName: "Unknown", lastName: "Lead" };
  const p = name.trim().split(/\s+/);
  if (p.length === 1) return { firstName: p[0], lastName: "Lead" };
  return { firstName: p[0], lastName: p.slice(1).join(" ") };
}

async function getPFToken() {
  if (tokenCache.pf.token && Date.now() < tokenCache.pf.expiresAt)
    return tokenCache.pf.token;

  const res = await axios.post("https://atlas.propertyfinder.com/v1/auth/token", {
    apiKey: process.env.PF_API_KEY,
    apiSecret: process.env.PF_API_SECRET,
  });

  tokenCache.pf.token = res.data.accessToken;
  tokenCache.pf.expiresAt = Date.now() + 50 * 60 * 1000;
  return tokenCache.pf.token;
}

async function getZohoToken() {
  if (tokenCache.zoho.token && Date.now() < tokenCache.zoho.expiresAt)
    return tokenCache.zoho.token;

  const res = await axios.post(
    "https://accounts.zoho.com/oauth/v2/token",
    null,
    {
      params: {
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
      },
    }
  );

  tokenCache.zoho.token = res.data.access_token;
  tokenCache.zoho.expiresAt = Date.now() + res.data.expires_in * 1000;

  return tokenCache.zoho.token;
}

function validateWebhookSignature(req) {
  const sig = req.headers["x-signature"];
  if (!sig) return false;

  const expected = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");

  return sig === expected;
}

function extractContacts(contacts) {
  let email = null,
    phone = null,
    mobile = null;

  if (!Array.isArray(contacts)) return { email, phone, mobile };

  contacts.forEach((c) => {
    if (c.type === "email" && !email) email = c.value;
    if (c.type === "phone" && !phone) phone = c.value;
    if (c.type === "mobile" && !mobile) mobile = c.value;
  });

  return {
    email,
    phone: phone || mobile,
    mobile,
  };
}

function generateLeadKey(lead) {
  const payload = lead.payload || {};
  const sender = payload.sender || {};
  const { email, phone } = extractContacts(sender.contacts || []);
  return crypto
    .createHash("md5")
    .update(`${lead.id}_${email}_${phone}`)
    .digest("hex");
}

// -----------------------------------------------------------------------------
// CLEAN VERSION — NO LISTING DETAILS, NO PROPERTY DETAILS, NO RESPONSE LINK, NO LEAD ID
// -----------------------------------------------------------------------------

app.post("/propertyfinder-lead", async (req, res) => {
  try {
    if (!validateWebhookSignature(req)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = req.body.payload;
    const sender = payload.sender;

    const { email, phone, mobile } = extractContacts(sender.contacts);
    const { firstName, lastName } = parseFullName(sender.name);

    // Prevent duplicates
    const key = generateLeadKey(req.body);
    if (processedLeads.has(key)) {
      return res.json({ message: "Duplicate lead skipped" });
    }

    const zohoToken = await getZohoToken();

    // ----------------------------
    // FINAL CLEAN DESCRIPTION
    // ----------------------------
    const description = [
      `Property Reference: ${payload.listing?.reference || "N/A"}`,
      `Channel: ${payload.channel || "N/A"}`
    ].join("\n");

    const zohoPayload = {
      data: [
        {
          First_Name: firstName,
          Last_Name: lastName,
          Email: email,
          Phone: phone,
          Mobile: mobile || phone,
          Lead_Source: "Property Finder",

          // ONLY 2 FIELDS SENT NOW
          Description: description,
        },
      ],
      trigger: ["approval", "workflow", "blueprint"],
    };

    const response = await axios.post(
      "https://www.zohoapis.com/crm/v2/Leads",
      zohoPayload,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${zohoToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    processedLeads.add(key);
    if (processedLeads.size > LEAD_CACHE_SIZE)
      processedLeads.delete(processedLeads.values().next().value);

    res.json({
      message: "Lead sent to Zoho successfully",
      result: response.data,
    });
  } catch (err) {
    console.error("Lead error:", err.response?.data || err.message);
    res.status(500).json({ error: "Processing failed" });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "healthy", now: new Date().toISOString() });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server running on port", process.env.PORT || 3000)
);
