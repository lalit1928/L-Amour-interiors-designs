/**
 * L'Amour Interior Designs — Express Backend v4.0
 * Image generation: Cloudflare Worker (free) → Replicate (paid fallback)
 */
import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { generateImages, getProviderStatus } from './services/imageService.js';
import { validatePrompt, validateStyle } from './utils/promptValidator.js';
import { persistImages } from './utils/storageService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Firebase Admin ──
import admin from 'firebase-admin';
let db, bucket, firebaseReady = false;
try {
  let sa;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,'base64').toString('utf8'));
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-service-account.json';
    if (existsSync(p)) sa = JSON.parse(readFileSync(p,'utf8'));
    else console.warn(`⚠️  Firebase SA not found at "${p}"`);
  }
  if (sa) {
    admin.initializeApp({ credential: admin.credential.cert(sa), storageBucket: process.env.FIREBASE_STORAGE_BUCKET });
    db = admin.firestore(); bucket = admin.storage().bucket(); firebaseReady = true;
    console.log('🔥 Firebase Admin ready');
  }
} catch(e) { console.error('❌ Firebase init failed:', e.message); }

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── CORS ──
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(o=>o.trim());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "data:", "https://storage.googleapis.com", "https://replicate.delivery"],
      "script-src": ["'self'", "'unsafe-inline'", "https://www.gstatic.com", "https://www.google.com"],
      "connect-src": ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://lamour-image-gen.*.workers.dev"]
    }
  }
}));
app.use(cors({ origin:(o,cb)=>(!o||process.env.NODE_ENV!=='production'||allowedOrigins.includes(o))?cb(null,true):cb(new Error('CORS')), credentials:true }));
app.use(express.json({ limit:'10mb' }));
app.use(express.static(path.join(__dirname,'public'), { maxAge:'1d', etag:true }));

// ── Rate limits ──
app.use('/api/', rateLimit({ windowMs:15*60*1000, max:100, standardHeaders:true, legacyHeaders:false, message:{error:'Too many requests'} }));
app.use('/api/generate', rateLimit({ windowMs:60*1000, max:5, message:{error:'Rate limit — wait 1 minute'} }));

// ── Auth middleware ──
async function authMiddleware(req,res,next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({error:'Unauthorised'});
  if (!firebaseReady) return res.status(503).json({error:'Auth not configured'});
  try { req.user = await admin.auth().verifyIdToken(h.split(' ')[1]); next(); }
  catch(e) { res.status(401).json({error:e.code==='auth/id-token-expired'?'Session expired':'Invalid token'}); }
}

// ── Access middleware (trial/pro/daily limits) ──
async function accessMiddleware(req,res,next) {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({error:'User profile not found'});
    const d = snap.data();
    const trialEnd = d.createdAt.toMillis() + 30*24*60*60*1000;
    if (d.plan!=='pro' && Date.now()>=trialEnd) return res.status(403).json({error:'Trial expired',trialExpired:true});
    if (d.plan!=='pro') {
      const today = new Date().toDateString();
      const daily = d.lastGenDate===today ? (d.dailyGens||0) : 0;
      if (daily>=5) return res.status(429).json({error:'Daily limit reached (5/day) — upgrade for unlimited',dailyLimit:true});
    }
    req.userProfile = d; next();
  } catch(e) { console.error('[access]',e); res.status(500).json({error:'Could not verify account'}); }
}

// ── Routes ──
app.post('/api/user/create', authMiddleware, async(req,res)=>{
  try {
    const {name}=req.body; const {uid,email}=req.user;
    const ref=db.collection('users').doc(uid); const ex=await ref.get();
    if (ex.exists) return res.json({success:true,user:ex.data()});
    const profile={uid,name:name?.trim()||email.split('@')[0],email,avatar:(name||email).charAt(0).toUpperCase(),plan:'trial',createdAt:admin.firestore.FieldValue.serverTimestamp(),generationsUsed:0,dailyGens:0,lastGenDate:''};
    await ref.set(profile);
    res.status(201).json({success:true,user:profile});
  } catch(e) { console.error('[user/create]',e); res.status(500).json({error:'Failed to create profile'}); }
});

app.get('/api/me', authMiddleware, async(req,res)=>{
  try {
    const snap=await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({error:'User not found'});
    const d=snap.data(); const te=d.createdAt.toMillis()+30*24*60*60*1000;
    const gsSnap=await db.collection('users').doc(req.user.uid).collection('generations').orderBy('createdAt','desc').limit(6).get();
    res.json({name:d.name,email:d.email,plan:d.plan,avatar:d.avatar,trialDaysLeft:Math.max(0,Math.ceil((te-Date.now())/86400000)),generationsUsed:d.generationsUsed||0,recentGenerations:gsSnap.docs.map(x=>({id:x.id,...x.data()}))});
  } catch(e) { console.error('[/me]',e); res.status(500).json({error:'Failed to load profile'}); }
});

app.post('/api/generate', authMiddleware, accessMiddleware, async(req,res)=>{
  const {ok,error:pe,sanitised:prompt}=validatePrompt(req.body.prompt);
  if (!ok) return res.status(400).json({error:pe});
  const style=validateStyle(req.body.style); const uid=req.user.uid;
  console.log(`[generate] uid=${uid} style="${style}" prompt="${prompt.substring(0,50)}..."`);
  try {
    const result = await generateImages({prompt,style,uid});
    const images = await persistImages(bucket,result.images,uid);
    const genDoc = await db.collection('users').doc(uid).collection('generations').add({prompt,style,images,provider:result.provider,createdAt:admin.firestore.FieldValue.serverTimestamp()});
    const today  = new Date().toDateString();
    await db.collection('users').doc(uid).update({generationsUsed:admin.firestore.FieldValue.increment(1),dailyGens:req.userProfile.lastGenDate===today?admin.firestore.FieldValue.increment(1):1,lastGenDate:today});
    console.log(`✅ Generated ${images.length} images via ${result.provider} in ${result.latency_ms}ms`);
    res.json({images,generationId:genDoc.id,count:images.length,provider:result.provider,latency_ms:result.latency_ms});
  } catch(e) {
    console.error('[generate]',e.message);
    if (e.message.includes('limit')||e.message.includes('quota')) return res.status(429).json({error:e.message});
    if (e.message.includes('timed out')||e.message.includes('timeout')) return res.status(504).json({error:'Generation timed out — try again'});
    if (e.message.includes('not configured')) return res.status(503).json({error:'Generation service not configured'});
    res.status(500).json({error:'Generation failed — please try again.'});
  }
});

app.get('/api/generations', authMiddleware, async(req,res)=>{
  try {
    const snap=await db.collection('users').doc(req.user.uid).collection('generations').orderBy('createdAt','desc').limit(50).get();
    res.json(snap.docs.map(d=>{const x=d.data();return{id:d.id,prompt:x.prompt,style:x.style,images:x.images,provider:x.provider,createdAt:x.createdAt?.toMillis()||Date.now()};}));
  } catch(e) { res.status(500).json({error:'Failed to load gallery'}); }
});

app.post('/api/upgrade', authMiddleware, async(req,res)=>{
  try { await db.collection('users').doc(req.user.uid).update({plan:'pro'}); res.json({success:true,message:'Upgraded to Pro!'}); }
  catch(e) { res.status(500).json({error:'Upgrade failed'}); }
});

app.post('/api/contact', async(req,res)=>{
  const {name,email,project,message}=req.body;
  if (!name?.trim()||!email?.trim()) return res.status(400).json({error:'Name and email required'});
  try { if(firebaseReady) await db.collection('enquiries').add({name:name.trim(),email:email.trim(),project:project?.trim()||'',message:message?.trim()||'',createdAt:admin.firestore.FieldValue.serverTimestamp()}); }
  catch(e) { console.error('[contact]',e); }
  res.json({success:true,message:"Enquiry received. We'll be in touch within 24 hours."});
});

app.get('/api/health', (_req,res)=>{
  const p=getProviderStatus();
  res.json({status:'ok',version:'4.0.0',firebase:firebaseReady,providers:p,primary:p.cloudflare?'cloudflare':p.replicate?'replicate':'none',uptime:`${Math.floor(process.uptime())}s`,env:process.env.NODE_ENV||'development'});
});

app.get('*', (_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((e,_q,res,_n)=>{ console.error('[Unhandled]',e.message); res.status(500).json({error:'Internal server error'}); });

app.listen(PORT,()=>{
  const p=getProviderStatus();
  console.log(`\n╔═══════════════════════════════════════╗\n║  L'Amour v4.0  →  http://localhost:${PORT}  ║\n╠═══════════════════════════════════════╣\n║  Firebase:  ${firebaseReady?'✅':'❌'}                      ║\n║  CF Worker: ${p.cloudflare?'✅ (primary, FREE)':'❌ set CF_WORKER_URL'}       ║\n║  Replicate: ${p.replicate ?'✅ (fallback)   ':'❌ set API key'}       ║\n╚═══════════════════════════════════════╝\n`);
});
