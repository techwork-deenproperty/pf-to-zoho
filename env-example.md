# Environment Variables Configuration

## Property Finder API Credentials
PF_API_KEY=your_property_finder_api_key
PF_API_SECRET=your_property_finder_api_secret

## Webhook Configuration
WEBHOOK_URL=https://your-domain.com/propertyfinder-lead
WEBHOOK_SECRET=your_secure_random_secret_string

## Zoho CRM OAuth Credentials
ZOHO_CLIENT_ID=your_zoho_client_id
ZOHO_CLIENT_SECRET=your_zoho_client_secret
ZOHO_REFRESH_TOKEN=your_zoho_refresh_token

## Optional Configuration
PORT=3000
NODE_ENV=production

---

## Setup Instructions

### 1. Property Finder Setup
- Log into Property Finder Atlas API portal
- Generate API Key and API Secret
- Copy credentials to `PF_API_KEY` and `PF_API_SECRET`

### 2. Webhook Configuration
- Set `WEBHOOK_URL` to your publicly accessible endpoint (e.g., using ngrok for local testing)
- Generate a secure random string for `WEBHOOK_SECRET` (use: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)

### 3. Zoho CRM Setup
- Create a Zoho CRM OAuth application
- Generate OAuth credentials (Client ID, Client Secret)
- Authorize the app and generate a Refresh Token
- Copy values to respective environment variables

### 4. Installation
```bash
npm install
```

### 5. Run the Application
```bash
npm start
```
