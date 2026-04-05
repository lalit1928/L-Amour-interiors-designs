/**
 * L'Amour Interior Designs — Cloudflare Worker
 * ─────────────────────────────────────────────
 * Handles AI image generation using Cloudflare Workers AI (free tier).
 * API key stays server-side. Frontend calls /generate on this worker.
 *
 * Deploy: wrangler deploy
 * Local:  wrangler dev
 */

// ══════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════

/** Cloudflare AI model — best free-tier image model available */
const CF_IMAGE_MODEL = '@cf/stabilityai/stable-diffusion-xl-base-1.0';

/** Max prompt length — prevents abuse */
const MAX_PROMPT_LEN = 800;

/** Per-IP rate limit: 10 requests per minute */
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Style enrichment suffixes.
 * Applied server-side — client only sends a style name string.
 */
const STYLE_MAP = {
  'Dark Luxury': 'dark luxury interior design, obsidian walls, gold leaf accents, emerald velvet furnishings, cinematic moody lighting, 8K photorealistic architectural photography',
  'Minimalist':  'minimalist interior design, clean lines, neutral palette, diffused natural light, zen negative space, 8K photorealistic',
  'Cyberpunk':   'cyberpunk interior design, neon blue purple lighting, chrome metallic surfaces, holographic displays, futuristic dark aesthetic, 8K photorealistic',
  'Realistic':   'hyperrealistic interior design photograph, 8K DSLR, professional architectural photography, natural light, ultra sharp focus',
  'Wabi-Sabi':   'wabi-sabi interior design, weathered natural wood, linen textiles, earthy tones, Japanese imperfect beauty, 8K photorealistic',
  'Art Deco':    'art deco interior design, geometric sunburst patterns, black lacquer furniture, champagne gold trim, 1920s Hollywood glamour, 8K photorealistic',
};

const NEGATIVE_PROMPT =
  'ugly, blurry, distorted, watermark, text overlay, cartoon, anime, low quality, ' +
  'bad anatomy, deformed, noise, pixelated, oversaturated, people, faces, figures';

// ══════════════════════════════════════════════════
//  CORS HEADERS
// ══════════════════════════════════════════════════

/**
 * Build CORS headers scoped to the requesting origin.
 * In production, replace '*' with your actual domain.
 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());

  // Allow all origins in dev, restrict in production
  const allowOrigin = env.ENVIRONMENT === 'production'
    ? (allowed.includes(origin) ? origin : allowed[0] || '')
    : '*';

  return {
    'Access-Control-Allow-Origin':  allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-ID',
    'Access-Control-Max-Age':       '86400',
  };
}

// ══════════════════════════════════════════════════
//  RATE LIMITER  (uses Cloudflare KV or Durable Objects)
//  Falls back to a lightweight in-memory map for simplicity.
//  For production scale: swap with Durable Objects.
// ══════════════════════════════════════════════════

/** In-memory store — resets on Worker restart (acceptable for edge nodes) */
const rateLimitStore = new Map();

/**
 * Returns true if the request is allowed, false if rate-limited.
 * Uses IP as key with a sliding window counter.
 */
function checkRateLimit(ip) {
  const now  = Date.now();
  const key  = ip || 'unknown';
  const data = rateLimitStore.get(key) || { count: 0, windowStart: now };

  // Reset window if expired
  if (now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
    data.count       = 1;
    data.windowStart = now;
    rateLimitStore.set(key, data);
    return true;
  }

  if (data.count >= RATE_LIMIT_REQUESTS) {
    return false; // rate-limited
  }

  data.count++;
  rateLimitStore.set(key, data);
  return true;
}

// ══════════════════════════════════════════════════
//  RESPONSE HELPERS
// ══════════════════════════════════════════════════

const jsonResponse = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const errorResponse = (message, status, cors) =>
  jsonResponse({ error: message, status }, status, cors);

// ══════════════════════════════════════════════════
//  IMAGE UPLOAD TO R2 (optional — for permanent URLs)
// ══════════════════════════════════════════════════

/**
 * Uploads a raw image buffer to Cloudflare R2.
 * If R2 bucket is not configured, returns null (caller uses data URL).
 *
 * @param {R2Bucket}    bucket   - env.IMAGES_BUCKET
 * @param {Uint8Array}  buffer   - raw image bytes
 * @param {string}      uid      - user ID (for path namespacing)
 * @param {number}      index    - image index (0–3)
 * @returns {string|null}        - public R2 URL or null
 */
async function uploadToR2(bucket, buffer, uid, index) {
  if (!bucket) return null;

  try {
    const timestamp = Date.now();
    const key       = `generations/${uid}/${timestamp}_${index}.png`;

    await bucket.put(key, buffer, {
      httpMetadata: {
        contentType:  'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: { uid, createdAt: new Date().toISOString() },
    });

    // Return public URL (requires R2 bucket with public access enabled)
    return `${bucket._options?.publicUrl || ''}/${key}`;
  } catch (err) {
    console.error('[R2 upload]', err.message);
    return null; // non-fatal — caller handles fallback
  }
}

// ══════════════════════════════════════════════════
//  MAIN WORKER HANDLER
// ══════════════════════════════════════════════════

export default {
  /**
   * Main fetch handler — routes all requests.
   *
   * Bindings required in wrangler.toml:
   *   [ai]                — Workers AI binding (env.AI)
   *   [[r2_buckets]]      — optional, for permanent image storage (env.IMAGES_BUCKET)
   *   [vars]
   *     ALLOWED_ORIGINS   — comma-separated allowed origins
   *     ENVIRONMENT       — "production" | "development"
   *     WORKER_SECRET     — shared secret between Express and this Worker
   */
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    // ── CORS preflight ──────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // ── Health check ────────────────────────────────
    if (url.pathname === '/health') {
      return jsonResponse({
        status:      'ok',
        worker:      'lamour-image-gen',
        model:       CF_IMAGE_MODEL,
        ai_binding:  !!env.AI,
        r2_binding:  !!env.IMAGES_BUCKET,
        environment: env.ENVIRONMENT || 'development',
        timestamp:   new Date().toISOString(),
      }, 200, cors);
    }

    // ── Only POST /generate is accepted ─────────────
    if (url.pathname !== '/generate' || request.method !== 'POST') {
      return errorResponse('Not found', 404, cors);
    }

    // ── Verify shared secret (server → worker auth) ──
    const authHeader = request.headers.get('Authorization') || '';
    const secret     = authHeader.replace('Bearer ', '').trim();
    if (env.WORKER_SECRET && secret !== env.WORKER_SECRET) {
      return errorResponse('Unauthorised', 401, cors);
    }

    // ── Rate limiting ────────────────────────────────
    const clientIP = request.headers.get('CF-Connecting-IP') ||
                     request.headers.get('X-Forwarded-For') || 'unknown';
    if (!checkRateLimit(clientIP)) {
      return errorResponse(
        'Rate limit reached — please wait 1 minute before generating again.',
        429,
        { ...cors, 'Retry-After': '60' }
      );
    }

    // ── Parse + validate request body ───────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON in request body', 400, cors);
    }

    const { prompt, style = 'Dark Luxury', uid = 'anonymous' } = body;

    if (!prompt || typeof prompt !== 'string') {
      return errorResponse('prompt is required', 400, cors);
    }

    const trimmedPrompt = prompt.trim();

    if (trimmedPrompt.length < 5) {
      return errorResponse('Prompt must be at least 5 characters', 400, cors);
    }
    if (trimmedPrompt.length > MAX_PROMPT_LEN) {
      return errorResponse(`Prompt too long — keep it under ${MAX_PROMPT_LEN} characters`, 400, cors);
    }

    // ── Build enriched prompt ────────────────────────
    const styleEnrichment = STYLE_MAP[style] || STYLE_MAP['Dark Luxury'];
    const fullPrompt = `${trimmedPrompt}, ${styleEnrichment}, no people, no text, no watermark`;

    // ── Call Cloudflare Workers AI ───────────────────
    if (!env.AI) {
      return errorResponse(
        'AI binding not configured — add [ai] binding in wrangler.toml',
        503,
        cors
      );
    }

    const startTime = Date.now();

    try {
      /**
       * Cloudflare Workers AI — stable-diffusion-xl-base-1.0
       * Returns raw PNG bytes as ArrayBuffer.
       *
       * Free tier: 10,000 neurons/day
       * One 512×512 image costs ~333 neurons → ~30 images/day free
       * One 1024×1024 image costs ~1333 neurons → ~7 images/day free
       *
       * We use 512×512 for free tier efficiency.
       * Upgrade to 768×768 or 1024×1024 with a paid plan.
       */
      const imageResponse = await env.AI.run(CF_IMAGE_MODEL, {
        prompt:          fullPrompt,
        negative_prompt: NEGATIVE_PROMPT,
        num_steps:       20,        // 20 = good quality, faster than 30
        guidance:        7.5,       // prompt adherence
        width:           512,       // free tier sweet spot
        height:          512,
      });

      const latencyMs = Date.now() - startTime;
      console.log(`[CF AI] Generated in ${latencyMs}ms for uid=${uid}`);

      // imageResponse is ReadableStream of PNG bytes
      const imageBuffer = await new Response(imageResponse).arrayBuffer();

      if (!imageBuffer || imageBuffer.byteLength === 0) {
        return errorResponse('AI returned empty image — please try again', 500, cors);
      }

      // ── Optional: Upload to R2 for permanent storage ──
      let r2Url = null;
      if (env.IMAGES_BUCKET) {
        // Non-blocking — don't delay response waiting for R2
        ctx.waitUntil(
          uploadToR2(env.IMAGES_BUCKET, new Uint8Array(imageBuffer), uid, Date.now())
            .then(url => { r2Url = url; })
            .catch(err => console.error('[R2]', err.message))
        );
      }

      // ── Convert to base64 for JSON response ──────────
      // Clients receive base64 data URL — no expiry, no hosting dependency
      const base64 = btoa(
        new Uint8Array(imageBuffer).reduce((s, b) => s + String.fromCharCode(b), '')
      );
      const dataUrl = `data:image/png;base64,${base64}`;

      return jsonResponse({
        success:    true,
        image:      dataUrl,          // base64 PNG — no expiry
        r2_url:     r2Url,            // permanent R2 URL (if configured)
        model:      CF_IMAGE_MODEL,
        style,
        latency_ms: latencyMs,
        uid,
      }, 200, {
        ...cors,
        'X-Generation-Latency': String(latencyMs),
        'Cache-Control':        'no-store', // don't cache generation responses
      });

    } catch (err) {
      console.error('[CF AI error]', err.message, err.stack);

      // Classify errors for better UX messaging
      if (err.message?.includes('overloaded') || err.message?.includes('quota')) {
        return errorResponse(
          'AI service is currently at capacity — please try again in a moment.',
          503,
          cors
        );
      }
      if (err.message?.includes('neurons') || err.message?.includes('limit')) {
        return errorResponse(
          'Daily free generation limit reached — try again tomorrow or upgrade.',
          429,
          cors
        );
      }

      return errorResponse(
        'Image generation failed — please try again.',
        500,
        cors
      );
    }
  },
};
