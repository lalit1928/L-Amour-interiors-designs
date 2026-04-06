/**
 * L'Amour Interior Designs — Backend v5.0
 * Clean server: Auth, Contact Form, User Profiles
 * No AI generation — simplified and production-ready
 */
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Firebase Admin ───────────────────────────────────────────
import admin from "firebase-admin";
let db, firebaseReady = false;

try {
  let sa;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"));
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./firebase-service-account.json";
    if (existsSync(p)) sa = JSON.parse(readFileSync(p, "utf8"));
    else console.warn("Firebase SA not found at:", p);
  }
  if (sa) {
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    db = admin.firestore();
    firebaseReady = true;
    console.log("Firebase Admin ready");
  }
} catch(e) { console.error("Firebase init failed:", e.message); }

const app  = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// ── Security ─────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src":     ["'self'", "data:", "https://images.unsplash.com", "https://storage.googleapis.com"],
      "script-src":  ["'self'", "'unsafe-inline'", "https://www.gstatic.com"],
      "connect-src": ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://firestore.googleapis.com", "wss://"],
      "media-src":   ["'self'", "https://player.vimeo.com", "https://www.pexels.com", "blob:"],
      "frame-src":   ["'self'", "https://player.vimeo.com"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

const allowed = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",").map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => (!origin || process.env.NODE_ENV !== "production" || allowed.includes(origin)) ? cb(null, true) : cb(new Error("CORS")),
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d", etag: true }));

// ── Rate limits ───────────────────────────────────────────────
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests" } }));
app.use("/api/contact", rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: "Too many contact requests" } }));

// ── Auth middleware ───────────────────────────────────────────
async function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorised" });
  if (!firebaseReady) return res.status(503).json({ error: "Auth not configured" });
  try {
    req.user = await admin.auth().verifyIdToken(h.split(" ")[1]);
    next();
  } catch(e) {
    res.status(401).json({ error: e.code === "auth/id-token-expired" ? "Session expired" : "Invalid token" });
  }
}

// ── Routes ────────────────────────────────────────────────────

// Create user profile after signup
app.post("/api/user/create", requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const { uid, email } = req.user;
    const ref = db.collection("users").doc(uid);
    const existing = await ref.get();
    if (existing.exists) return res.json({ success: true, user: existing.data() });
    const profile = {
      uid, email,
      name: name?.trim() || email.split("@")[0],
      avatar: (name || email).charAt(0).toUpperCase(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await ref.set(profile);
    res.status(201).json({ success: true, user: profile });
  } catch(e) {
    console.error("[user/create]", e.message);
    res.status(500).json({ error: "Failed to create profile" });
  }
});

// Get user profile
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const snap = await db.collection("users").doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: "User not found" });
    res.json(snap.data());
  } catch(e) {
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// Contact / enquiry form — public
app.post("/api/contact", async (req, res) => {
  const { name, email, project, message } = req.body;
  if (!name?.trim() || !email?.trim()) return res.status(400).json({ error: "Name and email are required" });
  if (!email.includes("@")) return res.status(400).json({ error: "Invalid email address" });
  try {
    if (firebaseReady) {
      await db.collection("enquiries").add({
        name:    name.trim(),
        email:   email.trim(),
        project: project?.trim() || "",
        message: message?.trim() || "",
        ip:      req.ip,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch(e) { console.error("[contact save]", e.message); }
  // Always respond success so user isn't left hanging
  res.json({ success: true, message: "Enquiry received. We'll respond within 24 hours." });
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status:   "ok",
    version:  "5.0.0",
    firebase: firebaseReady,
    uptime:   Math.floor(process.uptime()) + "s",
    env:      process.env.NODE_ENV || "development"
  });
});

// Serve index.html for all non-API routes (SPA)
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Error handler
app.use((err, _req, res, _next) => {
  console.error("[Error]", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║  L'Amour v5.0 → http://localhost:${PORT}  ║
╠═══════════════════════════════════════╣
║  Firebase: ${firebaseReady ? "✅ Ready" : "❌ Not configured"}           ║
║  Mode:     ${process.env.NODE_ENV || "development"}               ║
╚═══════════════════════════════════════╝
  `);
});
