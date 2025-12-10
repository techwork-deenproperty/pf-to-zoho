# Property Finder to Zoho CRM Integration

Automated API service that syncs leads from Property Finder directly to Zoho CRM in real-time using webhooks.

## 🚀 Features

- ✅ **Automatic Lead Sync** - Real-time webhook integration with Property Finder
- 🔒 **Webhook Signature Validation** - Secure signature verification for all incoming webhooks
- 🔄 **Automatic Retry Logic** - Exponential backoff for failed API requests
- 💾 **Token Caching** - Efficient token management with automatic refresh
- 🔍 **Duplicate Detection** - Prevents duplicate leads from being created
- 📊 **Comprehensive Logging** - Detailed logs for monitoring and debugging
- 🏥 **Health Check Endpoint** - Monitor service availability
- 🛡️ **Input Validation** - Robust validation for all incoming data
- 🎯 **Name Parsing** - Intelligent parsing of full names into First/Last name
- 🔧 **Graceful Shutdown** - Proper cleanup on process termination

## 📋 Requirements

- Node.js 18+ (for native watch mode)
- Property Finder API credentials
- Zoho CRM OAuth credentials
- Publicly accessible HTTPS endpoint (for webhooks)

## 🔧 Installation

1. **Clone and install dependencies:**
```bash
npm install
```

2. **Set up environment variables:**
```bash
# Copy the example file
cp .env.example .env

# Edit .env with your actual credentials
```

3. **Generate a secure webhook secret:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## ⚙️ Configuration

See `env-example.md` for detailed setup instructions. Required environment variables:

| Variable | Description |
|----------|-------------|
| `PF_API_KEY` | Property Finder API Key |
| `PF_API_SECRET` | Property Finder API Secret |
| `WEBHOOK_URL` | Your public webhook endpoint URL |
| `WEBHOOK_SECRET` | Secure random string for signature validation |
| `ZOHO_CLIENT_ID` | Zoho CRM OAuth Client ID |
| `ZOHO_CLIENT_SECRET` | Zoho CRM OAuth Client Secret |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM Refresh Token |
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | Environment (development/production) |

## 🚦 Usage

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

## 📡 API Endpoints

### POST `/propertyfinder-lead`
Webhook endpoint for receiving leads from Property Finder.

**Security:** Validates webhook signature using HMAC-SHA256

**Request:** Automatically sent by Property Finder when a lead is created

**Response:**
```json
{
  "message": "Lead successfully sent to Zoho CRM",
  "zohoLeadId": "4876900000123456"
}
```

### GET `/health`
Health check endpoint for monitoring service status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 3600.5
}
```

## 🔒 Security Features

1. **Webhook Signature Validation** - All webhook requests are validated using HMAC-SHA256
2. **Environment Variable Validation** - Server won't start without required credentials
3. **Token Caching** - Minimizes API calls and reduces exposure
4. **Timing-Safe Comparison** - Prevents timing attacks on signature validation
5. **Error Message Sanitization** - Sensitive details hidden in production

## 🛠️ Data Mapping

Property Finder leads are mapped to Zoho CRM as follows:

| Property Finder | Zoho CRM | Notes |
|----------------|----------|-------|
| `sender.name` | `First_Name` + `Last_Name` | Intelligently parsed |
| `sender.contacts[].email` | `Email` | Extracted from contacts array |
| `sender.contacts[].phone` | `Phone` + `Mobile` | Extracted from contacts array |
| `listing.property_type` | `Property_Type` + `Description` | Fetched via API |
| `listing.project.name` | `Project_Name` + `Description` | Fetched via API |
| `listing.title` | `Description` | Fetched via API |
| `listing.location` | `City` + `Description` | Fetched via API |
| `listing.price` | `Description` | If available |
| `listing.bedrooms` | `Description` | If available |
| `listing.size` | `Description` | If available |
| `listing.reference` | `Description` | Included in description |
| `payload.channel` | `Description` | WhatsApp, Email, etc. |
| `payload.responseLink` | `Description` | Link to lead in PF |
| - | `Lead_Source` | Set to "Property Finder" |

**Note:** The system fetches full listing details from Property Finder API to enrich lead data with property type, project name, and other details.

## 🔄 Duplicate Handling

**Multiple Property Inquiries Allowed:**
- Same person can inquire about **multiple properties**
- Each inquiry creates a **separate lead** in Zoho CRM
- Duplicate checking is disabled via `duplicate_check_fields: []`

**Example:**
```
John Doe inquires about:
1. Property A (Villa in Dubai Marina) → Lead #1 created ✅
2. Property B (Apartment in JBR) → Lead #2 created ✅
3. Property A again (same villa) → Duplicate detected, skipped ✅
```

**Local Duplicate Prevention:**
- Tracks last 1000 processed Property Finder lead IDs
- Prevents processing the exact same webhook multiple times
- Based on unique combination: `lead.id + email + phone`

## 📊 Monitoring

**Logs include:**
- ✅ Successful lead syncs with Zoho Lead ID
- ⚠️ Duplicate lead detection
- ❌ Failed authentication attempts
- 🔄 Token refresh events
- 📍 Webhook registration status

**Example log output:**
```
🚀 Server running on port 3000
📍 Webhook endpoint: https://your-domain.com/propertyfinder-lead
🏥 Health check: http://localhost:3000/health
✅ Webhook registered with Property Finder
✅ Lead pushed to Zoho: {
  name: 'John Doe',
  email: 'john@example.com',
  phone: '+971501234567',
  propertyType: 'Apartment',
  projectName: 'Marina Heights Tower',
  zohoId: '4876900000123456',
  channel: 'whatsapp'
}
```

## 🧪 Testing

**Test webhook locally using ngrok:**
```bash
# Start ngrok
ngrok http 3000

# Copy the HTTPS URL to WEBHOOK_URL in .env
# Example: https://abc123.ngrok.io/propertyfinder-lead
```

**Test health endpoint:**
```bash
curl http://localhost:3000/health
```

## 🐛 Troubleshooting

### Webhook not receiving leads
- Verify `WEBHOOK_URL` is publicly accessible
- Check Property Finder webhook registration in their dashboard
- Verify webhook signature validation is passing

### Token authentication errors
- Confirm all Zoho/Property Finder credentials are correct
- Check if Zoho refresh token has expired (regenerate if needed)
- Verify API access permissions in Zoho CRM

### Duplicate leads being created
- Check if lead ID generation is working correctly
- Review duplicate detection cache size (`LEAD_CACHE_SIZE`)
- Verify incoming lead data structure

## 🔄 Automatic Retry Logic

The service automatically retries failed requests with exponential backoff for:
- Network errors
- Rate limiting (429 status)
- Server errors (500+)

**Default configuration:**
- Max retries: 3
- Delay: Exponential backoff

## 🏗️ Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────┐
│ Property Finder │ webhook │   Your Server    │  OAuth  │  Zoho CRM   │
│                 ├────────>│                  ├────────>│             │
│  (Lead Created) │         │ Token Cache      │         │  (New Lead) │
└─────────────────┘         │ Signature Check  │         └─────────────┘
                            │ Duplicate Filter │
                            │ Data Mapping     │
                            └──────────────────┘
```

## 📝 Best Practices

1. **Use HTTPS** for webhook endpoint in production
2. **Monitor logs** regularly for errors and anomalies
3. **Rotate secrets** periodically for security
4. **Set up alerts** for failed lead syncs
5. **Test thoroughly** in development before production deployment
6. **Keep dependencies updated** for security patches

## 📄 License

ISC

## 🤝 Support

For issues or questions:
1. Check the troubleshooting section
2. Review application logs
3. Verify environment configuration
4. Contact Property Finder/Zoho support for API-specific issues
