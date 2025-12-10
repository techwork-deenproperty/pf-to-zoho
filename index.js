import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import axiosRetry from "axios-retry";

dotenv.config();

// Configure axios retry for resilience
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
           error.response?.status === 429 || // Rate limit
           error.response?.status >= 500;     // Server errors
  },
});

const app = express();
app.use(express.json());

// Validate required environment variables
const requiredEnvVars = [
  'PF_API_KEY',
  'PF_API_SECRET',
  'WEBHOOK_URL',
  'WEBHOOK_SECRET',
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Token cache to avoid unnecessary API calls
const tokenCache = {
  pf: { token: null, expiresAt: 0 },
  zoho: { token: null, expiresAt: 0 },
};

// Track processed leads to prevent duplicates
const processedLeads = new Set();
const LEAD_CACHE_SIZE = 1000;

// Helper function to parse full name into first and last name
function parseFullName(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return { firstName: 'Unknown', lastName: 'Lead' };
  }
  
  const nameParts = fullName.trim().split(/\s+/);
  if (nameParts.length === 1) {
    return { firstName: nameParts[0], lastName: 'Lead' };
  }
  
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ');
  return { firstName, lastName };
}

// Property Finder token with caching
async function getPFToken() {
  // Return cached token if still valid
  if (tokenCache.pf.token && Date.now() < tokenCache.pf.expiresAt) {
    return tokenCache.pf.token;
  }

  try {
    const res = await axios.post("https://atlas.propertyfinder.com/v1/auth/token", {
      apiKey: process.env.PF_API_KEY,
      apiSecret: process.env.PF_API_SECRET,
    });
    
    if (!res.data?.accessToken) {
      throw new Error('Invalid response from Property Finder auth API');
    }
    
    tokenCache.pf.token = res.data.accessToken;
    // Cache for 50 minutes (tokens typically valid for 1 hour)
    tokenCache.pf.expiresAt = Date.now() + 50 * 60 * 1000;
    
    return tokenCache.pf.token;
  } catch (error) {
    console.error('❌ Failed to get Property Finder token:', error.response?.data || error.message);
    throw new Error('Property Finder authentication failed');
  }
}

// Zoho token with caching
async function getZohoAccessToken() {
  // Return cached token if still valid
  if (tokenCache.zoho.token && Date.now() < tokenCache.zoho.expiresAt) {
    return tokenCache.zoho.token;
  }

  try {
    const res = await axios.post("https://accounts.zoho.com/oauth/v2/token", null, {
      params: {
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
      },
    });
    
    if (!res.data?.access_token) {
      throw new Error('Invalid response from Zoho auth API');
    }
    
    tokenCache.zoho.token = res.data.access_token;
    // Cache based on expires_in from response, default to 50 minutes
    const expiresIn = (res.data.expires_in || 3600) * 1000;
    tokenCache.zoho.expiresAt = Date.now() + expiresIn - 10 * 60 * 1000; // 10 min buffer
    
    return tokenCache.zoho.token;
  } catch (error) {
    console.error('❌ Failed to get Zoho token:', error.response?.data || error.message);
    throw new Error('Zoho authentication failed');
  }
}

// Register webhook (idempotent - checks if already exists)
async function registerWebhook() {
  try {
    const token = await getPFToken();
    
    // Check existing webhooks first
    const existingWebhooks = await axios.get(
      "https://atlas.propertyfinder.com/v1/webhooks",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    // Handle different response structures
    let webhooks = [];
    if (Array.isArray(existingWebhooks.data)) {
      webhooks = existingWebhooks.data;
    } else if (existingWebhooks.data?.data && Array.isArray(existingWebhooks.data.data)) {
      webhooks = existingWebhooks.data.data;
    } else if (existingWebhooks.data?.webhooks && Array.isArray(existingWebhooks.data.webhooks)) {
      webhooks = existingWebhooks.data.webhooks;
    }
    
    // Check if webhook already exists for this event and URL
    const webhookExists = webhooks.some(
      (wh) => wh.eventId === "lead.created" && wh.callbackUrl === process.env.WEBHOOK_URL
    );
    
    if (webhookExists) {
      console.log("✅ Webhook already registered with Property Finder");
      return;
    }
    
    // Register new webhook
    await axios.post(
      "https://atlas.propertyfinder.com/v1/webhooks",
      {
        eventId: "lead.created",
        callbackUrl: process.env.WEBHOOK_URL,
        secret: process.env.WEBHOOK_SECRET,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    console.log("✅ Webhook registered with Property Finder");
  } catch (error) {
    console.error('❌ Failed to register webhook:', error.response?.data || error.message);
    // Don't crash the server if webhook registration fails
    console.warn('⚠️  Server will continue running, but you may need to register webhook manually');
  }
}

// Validate webhook signature
function validateWebhookSignature(req) {
  const signature = req.headers['x-signature'];
  
  // Debug logging in development
  if (process.env.NODE_ENV === 'development') {
    console.log('🔍 Debug - Webhook Headers:', {
      allHeaders: Object.keys(req.headers),
      signature: signature,
      hasSignature: !!signature,
    });
  }
  
  if (!signature) {
    console.warn('⚠️  No signature header found in request');
    return false;
  }
  
  const payload = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  
  // Debug logging
  if (process.env.NODE_ENV === 'development') {
    console.log('🔍 Debug - Signature Validation:', {
      received: signature.substring(0, 20) + '...',
      expected: expectedSignature.substring(0, 20) + '...',
      match: signature === expectedSignature,
    });
  }
  
  // Handle different signature lengths safely
  if (signature.length !== expectedSignature.length) {
    console.warn(`⚠️  Signature length mismatch: received ${signature.length}, expected ${expectedSignature.length}`);
    return false;
  }
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Extract contact info from Property Finder contacts array
function extractContacts(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return { email: null, phone: null, mobile: null };
  }
  
  let email = null;
  let phone = null;
  let mobile = null;
  
  contacts.forEach(contact => {
    if (contact.type === 'email' && !email) {
      email = contact.value;
    } else if (contact.type === 'phone' || contact.type === 'mobile') {
      if (!phone) phone = contact.value;
      if (contact.type === 'mobile' && !mobile) mobile = contact.value;
    }
  });
  
  return { email, phone: phone || mobile, mobile };
}

// Generate unique lead ID from lead data
function generateLeadId(lead) {
  const payload = lead.payload || lead;
  const sender = payload.sender || lead.sender;
  const contacts = sender?.contacts || [];
  const { email, phone } = extractContacts(contacts);
  
  const uniqueString = `${lead.id || ''}_${email || ''}_${phone || ''}`;
  return crypto.createHash('md5').update(uniqueString).digest('hex');
}

// Fetch listing details from Property Finder API
async function getListingDetails(listingId) {
  try {
    const token = await getPFToken();
    const response = await axios.get(
      `https://atlas.propertyfinder.com/v1/listings/${listingId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return response.data;
  } catch (error) {
    console.warn('⚠️  Failed to fetch listing details:', error.response?.data || error.message);
    return null;
  }
}

// Receive lead → push to Zoho
app.post("/propertyfinder-lead", async (req, res) => {
  const lead = req.body;
  
  try {
    // Validate webhook signature for security
    if (!validateWebhookSignature(req)) {
      console.warn('⚠️  Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // Log full webhook payload in development
    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 Debug - Full Webhook Payload:', JSON.stringify(lead, null, 2));
    }
    
    // Property Finder sends data in payload object
    const payload = lead.payload || lead;
    const sender = payload.sender || lead.sender;
    
    // Validate required lead data
    if (!lead || !sender) {
      console.warn('⚠️  Invalid lead data received - missing sender:', lead);
      return res.status(400).json({ error: 'Invalid lead data' });
    }
    
    // Extract contact information from contacts array
    const { email, phone, mobile } = extractContacts(sender.contacts);
    
    // Log extracted contacts
    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 Debug - Extracted Contacts:', { email, phone, mobile });
    }
    
    // Check for duplicate leads
    const leadId = generateLeadId(lead);
    if (processedLeads.has(leadId)) {
      console.log('ℹ️  Duplicate lead detected, skipping:', email || phone);
      return res.status(200).json({ message: 'Duplicate lead, already processed' });
    }
    
    // Validate email or phone exists
    if (!email && !phone) {
      console.warn('⚠️  Lead has no email or phone:', sender);
      return res.status(400).json({ error: 'Lead must have email or phone' });
    }
    
    // Get Zoho access token
    const zohoToken = await getZohoAccessToken();
    
    // Parse name into first and last name
    const { firstName, lastName } = parseFullName(sender?.name);
    
    // Get listing info
    const listing = payload.listing || lead.listing || {};
    
    // Fetch full listing details from Property Finder
    let listingDetails = null;
    if (listing.id) {
      listingDetails = await getListingDetails(listing.id);
      if (process.env.NODE_ENV === 'development' && listingDetails) {
        console.log('🔍 Debug - Listing Details:', JSON.stringify(listingDetails, null, 2));
      }
    }
    
    // Extract property information
    const propertyType = listingDetails?.property_type || listingDetails?.type || 'N/A';
    const projectName = listingDetails?.project?.name || listingDetails?.building || listingDetails?.compound || 'N/A';
    const propertyTitle = listingDetails?.title || listingDetails?.name || 'N/A';
    const location = listingDetails?.location?.name || listingDetails?.area || 'N/A';
    const price = listingDetails?.price || listingDetails?.asking_price || null;
    const bedrooms = listingDetails?.bedrooms || listingDetails?.bedroom_count || null;
    const size = listingDetails?.size || listingDetails?.area_size || null;
    
    // Build comprehensive Zoho payload
    const zohoPayload = {
      data: [
        {
          First_Name: firstName,
          Last_Name: lastName,
          Email: email || null,
          Phone: phone || null,
          Mobile: mobile || phone || null,
          Lead_Source: "Property Finder",
          Description: [
            `Property Type: ${propertyType}`,
            `Project Name: ${projectName}`,
            `Property Title: ${propertyTitle}`,
            `Location: ${location}`,
            `Property Reference: ${listing.reference || 'N/A'}`,
            ...(bedrooms ? [`Bedrooms: ${bedrooms}`] : []),
            ...(size ? [`Size: ${size} sq ft`] : []),
            ...(price ? [`Price: AED ${price}`] : []),
            `Channel: ${payload.channel || 'N/A'}`,
            `Lead ID: ${lead.id || 'N/A'}`,
            `Response Link: ${payload.responseLink || 'N/A'}`,
          ].join('\n'),
          // Add custom fields if they exist in your Zoho CRM
          ...(propertyType && { Property_Type: propertyType }),
          ...(projectName && projectName !== 'N/A' && { Project_Name: projectName }),
          ...(location && { City: location }),
        },
      ],
      trigger: ['approval', 'workflow', 'blueprint'],
      duplicate_check_fields: [], // Allow duplicates - same person can inquire about multiple properties
    };
    
    // Push to Zoho CRM
    const zohoResponse = await axios.post(
      "https://www.zohoapis.com/crm/v2/Leads",
      zohoPayload,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${zohoToken}`,
          'Content-Type': 'application/json',
        },
        params: {
          duplicate_check_fields: '[]', // Allow duplicates via query parameter as well
        },
      }
    );
    
    // Check if Zoho API call was successful
    const responseData = zohoResponse.data?.data?.[0];
    
    if (responseData?.status === 'error') {
      // Zoho returned an error
      throw new Error(`Zoho API error: ${responseData.message} - ${JSON.stringify(responseData.details)}`);
    }
    
    // Extract Zoho Lead ID from response
    // Zoho API returns: { data: [{ details: { id: "..." }, status: "success" }] }
    const zohoLeadId = responseData?.details?.id || 
                       responseData?.id ||
                       null;
    
    // Only mark as processed if we successfully created the lead
    if (zohoLeadId) {
      processedLeads.add(leadId);
    }
    
    // Maintain cache size
    if (processedLeads.size > LEAD_CACHE_SIZE) {
      const firstItem = processedLeads.values().next().value;
      processedLeads.delete(firstItem);
    }
    
    console.log('✅ Lead pushed to Zoho:', {
      name: sender?.name,
      email: email,
      phone: phone,
      propertyType: propertyType,
      projectName: projectName,
      zohoId: zohoLeadId,
      channel: payload.channel,
      // Debug: log full response in development
      ...(process.env.NODE_ENV === 'development' && { 
        fullResponse: JSON.stringify(zohoResponse.data) 
      }),
    });
    
    res.status(200).json({
      message: 'Lead successfully sent to Zoho CRM',
      zohoLeadId: zohoLeadId,
    });
    
  } catch (err) {
    // Extract email/phone for error logging
    const errorPayload = lead?.payload || lead;
    const errorSender = errorPayload?.sender || lead?.sender;
    const errorContacts = extractContacts(errorSender?.contacts || []);
    
    console.error('❌ Error processing lead:', {
      error: err.response?.data || err.message,
      lead: errorContacts.email || errorContacts.phone || errorSender?.name,
      stack: err.stack,
    });
    
    // Return appropriate error status
    const statusCode = err.response?.status || 500;
    res.status(statusCode).json({
      error: 'Error processing lead',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Graceful shutdown handler
process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');
  process.exit(0);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Webhook endpoint: ${process.env.WEBHOOK_URL}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  
  // Register webhook with Property Finder
  await registerWebhook();
});
