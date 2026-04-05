# L'Amour Interior Designs — v3.0
### AI-Powered Dark Luxury Interior Design Platform

---

## 🚀 Quick Start (5 minutes)

### Step 1 — Clone & Install
```bash
npm install
```

### Step 2 — Firebase Service Account (REQUIRED)
1. Go to [Firebase Console](https://console.firebase.google.com) → Your project `lamour-ai`
2. Click **Project Settings** (gear icon) → **Service Accounts** tab
3. Click **"Generate new private key"** → Download the JSON file
4. Rename it to `firebase-service-account.json`
5. Place it in the **root** of this project (same folder as `server.js`)

> ⚠️ This file is in `.gitignore` — NEVER commit it to Git

### Step 3 — Environment Variables
Your `.env` file is already configured. Verify it contains:
```env
REPLICATE_API_KEY=r8_...        # Your Replicate key
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
FIREBASE_PROJECT_ID=lamour-ai
FIREBASE_STORAGE_BUCKET=lamour-ai.firebasestorage.app
PORT=3000
```

### Step 4 — Firebase Console Setup
Enable these services in your Firebase project:

**Authentication:**
- Firebase Console → Authentication → Sign-in method
- Enable **Email/Password**

**Firestore:**
- Firebase Console → Firestore Database → Create database
- Choose **Production mode**
- Set these security rules:
```
rules_version = '2';
service cloud.firestore.beta1 {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      match /generations/{genId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
    match /enquiries/{id} {
      allow write: if true; // public contact form
      allow read: if false; // admin only
    }
  }
}
```

**Storage:**
- Firebase Console → Storage → Get started
- Set these rules:
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /generations/{userId}/{allPaths=**} {
      allow read: if true;  // public read for generated images
      allow write: if false; // only server-side writes
    }
  }
}
```

### Step 5 — Run
```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

Open: **http://localhost:3000**

---

## ✅ Verify Everything Works
Visit `http://localhost:3000/api/health` — you should see:
```json
{
  "status": "ok",
  "firebase": true,
  "replicate": true,
  "uptime": "5s"
}
```

---

## 🏗 Deploy to Vercel (Recommended)

### Option A: Vercel CLI
```bash
npm i -g vercel
vercel

# Set environment variables:
vercel env add REPLICATE_API_KEY
vercel env add FIREBASE_STORAGE_BUCKET
# etc. for all .env vars
```

Then upload `firebase-service-account.json` content as env var:
```bash
# Encode to base64
base64 firebase-service-account.json

# Add as env var in Vercel dashboard:
# FIREBASE_SERVICE_ACCOUNT_BASE64 = <base64 string>
```

Add this to `server.js` top when deploying to Vercel:
```js
// In production, load service account from base64 env var
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString();
  const sa = JSON.parse(decoded);
  // use sa directly instead of reading file
}
```

### Option B: Railway / Render
Push to GitHub → Connect to Railway → Set all env vars in dashboard.

---

## 🔐 Security Checklist
- [x] Replicate API key — server-side only, never in frontend
- [x] Firebase service account — in `.gitignore`, never committed
- [x] Firebase client config — safe to expose (public key)
- [x] All API routes protected by Firebase Auth token verification
- [x] Rate limiting on all `/api/` routes (100 req/15min)
- [x] Rate limiting on `/api/generate` (5 req/min)
- [x] Input validation on all endpoints
- [x] User enumeration prevention on login

---

## 📦 Architecture

```
┌─────────────────────────────────────────────────────┐
│                   BROWSER (Frontend)                 │
│  index.html — Firebase Auth SDK (client-side only)  │
│  • Signs in via Firebase Auth (email/password)       │
│  • Gets Firebase ID token                            │
│  • Sends token with every API request                │
└────────────────────┬────────────────────────────────┘
                     │ HTTPS + Bearer token
┌────────────────────▼────────────────────────────────┐
│              Express Server (Backend)                │
│  • Verifies Firebase ID token (Admin SDK)            │
│  • Calls Replicate API (key never leaves server)     │
│  • Uploads images to Firebase Storage                │
│  • Saves generation records to Firestore             │
└──────────────┬──────────────────┬───────────────────┘
               │                  │
    ┌──────────▼──────┐  ┌───────▼────────┐
    │  Replicate API  │  │    Firebase    │
    │  (SDXL images)  │  │  Auth/Firestore │
    │                 │  │  /Storage      │
    └─────────────────┘  └────────────────┘
```

---

## 🐛 QA Report — Issues Found & Fixed

| # | Bug | Severity | Fix |
|---|-----|----------|-----|
| 1 | `prediction.id` undefined when Replicate returns error | 🔴 Critical | Added `!startRes.ok` check before parsing prediction |
| 2 | Images expired after ~1hr (Replicate temp URLs) | 🔴 Critical | Upload to Firebase Storage for permanent URLs |
| 3 | JWT stored in localStorage — XSS vulnerable | 🟠 High | Replaced with Firebase Auth (secure token management) |
| 4 | No rate limiting on generate endpoint | 🟠 High | Added express-rate-limit (5/min per IP) |
| 5 | User enumeration possible in login | 🟡 Medium | Constant-time response with dummy bcrypt hash |
| 6 | `renderHistory` crash with escaped backticks | 🔴 Critical | Rewrote with string concatenation |
| 7 | `loadDashboard` blank on page refresh | 🟠 High | Firebase `onAuthStateChanged` restores session |
| 8 | No input validation on prompt length | 🟡 Medium | Added min 3 / max 800 char validation |
| 9 | Missing error handling for 401/429/422 from Replicate | 🟠 High | Specific error messages per status code |
| 10 | Templates had generic descriptions, no real prompts | 🟡 Medium | Added `prompt` field with production-quality prompts |
| 11 | Generation timeout gave no user message | 🟡 Medium | Returns "timed out" error after 60s |
| 12 | Contact form not persisted anywhere | 🟢 Low | Saved to Firestore `enquiries` collection |

---

*© 2025 L'Amour Interior Designs. Built by Lalit Gangwar.*
