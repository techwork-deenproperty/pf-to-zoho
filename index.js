import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import axiosRetry from "axios-retry";
import fs from "fs";
import path from "path";

dotenv.config();

/* ----------------------------
   AXIOS RETRY
----------------------------- */
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      error.response?.status === 429 ||
      error.response?.status >= 500;
  },
});

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("Server is running");
});

/* ----------------------------
   CHECK ENV VARIABLES
----------------------------- */
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
  console.error("❌ Missing env vars:", missing.join(", "));
  process.exit(1);
}

/* ----------------------------
   TOKEN CACHES
----------------------------- */
const tokenCache = {
  pf: { token: null, expiresAt: 0 },
  zoho: { token: null, expiresAt: 0 },
};

/* ----------------------------
   PENDING LEADS SYSTEM (JSON STORAGE)
----------------------------- */

// Folder path → /storage
const storageDir = path.join(process.cwd(), "storage");

// File path → /storage/pending_leads.json
const pendingFile = path.join(storageDir, "pending_leads.json");

// 🔥 Create folder + JSON file automatically
if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir);

if (!fs.existsSync(pendingFile)) {
  fs.writeFileSync(pendingFile, JSON.stringify([]));
}

// Load pending leads from file
function loadPending() {
  try {
    return JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  } catch {
    return [];
  }
}

// Save pending leads back to file
function savePending(list) {
  fs.writeFileSync(pendingFile, JSON.stringify(list, null, 2));
}

// Add a lead to pending storage
function addPendingLead(leadObj) {
  const pending = loadPending();
  pending.push(leadObj);
  savePending(pending);
}


/* ----------------------------
   NAME PARSER
----------------------------- */
function parseFullName(fullName) {
  if (!fullName) return { firstName: "Unknown", lastName: "Lead" };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "Lead" };

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

/* ----------------------------
   EXTRACT CONTACTS
----------------------------- */
function extractContacts(contacts) {
  if (!Array.isArray(contacts)) return { email: null, phone: null };

  let email = null;
  let phone = null;

  contacts.forEach((c) => {
    if (c.type === "email" && !email) email = c.value;
    if ((c.type === "phone" || c.type === "mobile") && !phone) phone = c.value;
  });

  return { email, phone };
}

/* ----------------------------
   PROPERTY FINDER TOKEN
----------------------------- */
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

/* ----------------------------
   ZOHO TOKEN
----------------------------- */
async function getZohoAccessToken() {
  if (tokenCache.zoho.token && Date.now() < tokenCache.zoho.expiresAt)
    return tokenCache.zoho.token;

  const res = await axios.post("https://accounts.zoho.com/oauth/v2/token", null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token",
    },
  });

  tokenCache.zoho.token = res.data.access_token;
  tokenCache.zoho.expiresAt = Date.now() + (res.data.expires_in * 1000);

  return tokenCache.zoho.token;
}

/* ----------------------------
   SIGNATURE VALIDATION
----------------------------- */
function validateWebhookSignature(req) {
  const signature = req.headers["x-signature"];
  if (!signature) return false;

  const payload = JSON.stringify(req.body);
  const expected = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");

  return signature === expected;
}

/* ----------------------------
   SEND LEAD TO ZOHO (COMMON FUNCTION)
----------------------------- */
async function pushLeadToZoho(cleanLead) {
  try {
    const zohoToken = await getZohoAccessToken();

    const payload = {
      data: [
        {
          First_Name: cleanLead.firstName,
          Last_Name: cleanLead.lastName,
          Email: cleanLead.email,
          Phone: cleanLead.phone,
          Mobile: cleanLead.phone,
          Lead_Source: "Property Finder",
          Description: `Property Reference: ${cleanLead.reference || "N/A"}\nChannel: ${cleanLead.channel || "N/A"}`,
        },
      ],
    };

    const res = await axios.post(
      "https://www.zohoapis.com/crm/v2/Leads",
      payload,
      { headers: { Authorization: `Zoho-oauthtoken ${zohoToken}` } }
    );

    return res.data;
  } catch (err) {
    throw err;
  }
}

/* ---------------------------------------------------------
   PROPERTY FINDER WEBHOOK → RECEIVE LEAD
---------------------------------------------------------- */
app.post("/propertyfinder-lead", async (req, res) => {
  const body = req.body;

  // Validate signature
  if (!validateWebhookSignature(req)) {
    console.log("⚠️ Invalid signature");
    return res.status(401).send("Invalid signature");
  }

  try {
    const payload = body.payload || body;
    const sender = payload.sender;

    if (!sender) {
      return res.status(400).json({ error: "Invalid PF lead (no sender)" });
    }

    const { email, phone } = extractContacts(sender.contacts);
    if (!email && !phone) {
      return res.status(400).json({ error: "Lead must have email or phone" });
    }

    const { firstName, lastName } = parseFullName(sender.name);

    const cleanLead = {
      firstName,
      lastName,
      email,
      phone,
      reference: payload.listing?.id || "",
      channel: payload.channel || "",
    };

    // Try sending now
    try {
      const result = await pushLeadToZoho(cleanLead);

      console.log("✅ Lead sent instantly:", cleanLead.email || cleanLead.phone);
      return res.status(200).json({ message: "Lead sent to Zoho" });
    } catch (err) {
      console.log("⚠️ Zoho failed → Lead stored for retry");

      // 🔥 ADD TO PENDING FILE
      addPendingLead(cleanLead);

      return res.status(200).json({
        message: "Zoho down → Lead saved for retry",
      });
    }
  } catch (err) {
    console.log("❌ Error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});


/* ---------------------------------------------------------
   🔥 API #1 → MANUAL RETRY ALL PENDING LEADS
   GET /retry-pending
---------------------------------------------------------- */
app.get("/retry-pending", async (req, res) => {
  let pending = loadPending();
  if (pending.length === 0) {
    return res.status(200).json({ message: "No pending leads" });
  }

  let successCount = 0;
  let failCount = 0;
  let stillPending = [];

  for (let lead of pending) {
    try {
      await pushLeadToZoho(lead);
      successCount++;
    } catch (err) {
      failCount++;
      stillPending.push(lead);
    }
  }

  // Save leads which still failed
  savePending(stillPending);

  return res.status(200).json({
    total: pending.length,
    success: successCount,
    failed: failCount,
    remaining: stillPending.length,
  });
});


/* ---------------------------------------------------------
   🔥 API #2 → VIEW PENDING LEADS
   GET /pending-leads
---------------------------------------------------------- */
app.get("/pending-leads", (req, res) => {
  const pending = loadPending();
  res.status(200).json({ count: pending.length, pending });
});


/* ---------------------------------------------------------
   HEALTH CHECK
---------------------------------------------------------- */
app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});


/* ---------------------------------------------------------
   START SERVER
---------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  console.log("📦 Pending leads file:", pendingFile);
});
