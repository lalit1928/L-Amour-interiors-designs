/**
 * services/imageService.js
 * ─────────────────────────────────────────────────
 * Unified image generation service.
 *
 * Strategy (priority order):
 *   1. Cloudflare Workers AI  — free, fast, zero-cost per call
 *   2. Replicate SDXL         — paid fallback, higher quality
 *
 * The caller (server.js) uses this service and never knows
 * which backend was used — clean separation of concerns.
 */

import fetch from 'node-fetch';

// ── Config ──────────────────────────────────────────
const CF_WORKER_URL  = process.env.CF_WORKER_URL;   // e.g. https://lamour-image-gen.YOUR.workers.dev
const CF_WORKER_SECRET = process.env.CF_WORKER_SECRET; // shared secret
const REPLICATE_KEY  = process.env.REPLICATE_API_KEY;
const SDXL_VERSION   = '7762fd07cf82c948538e41f63f77d685e02b063e37e496af79703bd4fcf4cf1b';

/** Poll interval and max wait for Replicate */
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;

// ══════════════════════════════════════════════════
//  CLOUDFLARE WORKER GENERATION
// ══════════════════════════════════════════════════

/**
 * Calls the Cloudflare Worker to generate a single image.
 * Returns a base64 data URL (permanent, no expiry).
 *
 * @param {string} prompt      - user prompt
 * @param {string} style       - style preset name
 * @param {string} uid         - user UID (for R2 namespacing)
 * @returns {{ image: string, latency_ms: number }}
 */
async function generateWithCloudflare(prompt, style, uid) {
  if (!CF_WORKER_URL) {
    throw new Error('CF_WORKER_URL not set — Cloudflare Worker not configured');
  }

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 45_000); // 45s timeout

  try {
    const res = await fetch(`${CF_WORKER_URL}/generate`, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${CF_WORKER_SECRET || ''}`,
      },
      body: JSON.stringify({ prompt, style, uid }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || `Cloudflare Worker returned HTTP ${res.status}`;
      throw new Error(msg);
    }

    const data = await res.json();

    if (!data.image) {
      throw new Error('Cloudflare Worker returned no image data');
    }

    return {
      images:     [data.image],         // single base64 PNG
      latency_ms: data.latency_ms || 0,
      provider:   'cloudflare',
      model:      data.model,
    };

  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Cloudflare Worker timed out (45s) — please try again');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ══════════════════════════════════════════════════
//  REPLICATE SDXL GENERATION (fallback)
// ══════════════════════════════════════════════════

const STYLE_ENRICH = {
  'Dark Luxury': 'dark luxury interior design, obsidian walls, gold leaf accents, emerald velvet, cinematic lighting, 8K photorealistic',
  'Minimalist':  'minimalist interior design, clean lines, neutral palette, natural light, zen space, 8K photorealistic',
  'Cyberpunk':   'cyberpunk interior, neon lighting, chrome surfaces, holographic displays, futuristic, 8K photorealistic',
  'Realistic':   'hyperrealistic interior photograph, 8K DSLR, professional architectural photography, natural light',
  'Wabi-Sabi':   'wabi-sabi interior, weathered wood, linen, earthy tones, Japanese aesthetic, 8K photorealistic',
  'Art Deco':    'art deco interior, geometric patterns, black lacquer, champagne gold, 1920s glamour, 8K',
};

/**
 * Calls Replicate SDXL to generate 4 images.
 * Returns array of temporary Replicate CDN URLs.
 *
 * @param {string} prompt
 * @param {string} style
 * @returns {{ images: string[], latency_ms: number, provider: string }}
 */
async function generateWithReplicate(prompt, style) {
  if (!REPLICATE_KEY) {
    throw new Error('REPLICATE_API_KEY not configured — cannot use Replicate fallback');
  }

  const enrichment = STYLE_ENRICH[style] || STYLE_ENRICH['Dark Luxury'];
  const fullPrompt = `${prompt.trim()}, ${enrichment}, no people, no text`;
  const startTime  = Date.now();

  // Start prediction
  const startRes = await fetch('https://api.replicate.com/v1/predictions', {
    method:  'POST',
    headers: {
      Authorization:  `Token ${REPLICATE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer':       'wait=60',
    },
    body: JSON.stringify({
      version: SDXL_VERSION,
      input: {
        prompt:              fullPrompt,
        negative_prompt:     'ugly, blurry, low quality, watermark, text, signature, bad proportions, deformed, noise, pixelated, people, faces',
        num_outputs:         4,
        width:               1024,
        height:              1024,
        num_inference_steps: 30,
        guidance_scale:      7.5,
        scheduler:           'K_EULER',
      },
    }),
  });

  if (!startRes.ok) {
    const body = await startRes.text();
    if (startRes.status === 401) throw new Error('Replicate API key is invalid');
    if (startRes.status === 429) throw new Error('Replicate rate limit — please wait a moment');
    throw new Error(`Replicate API error (${startRes.status}): ${body.slice(0, 200)}`);
  }

  let prediction = await startRes.json();

  // Poll for completion
  let attempts = 0;
  while (
    prediction.status !== 'succeeded' &&
    prediction.status !== 'failed'    &&
    prediction.status !== 'canceled'  &&
    attempts < MAX_POLL_ATTEMPTS
  ) {
    if (!prediction.id) throw new Error('Replicate returned invalid prediction — no ID');

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const pollRes = await fetch(
      `https://api.replicate.com/v1/predictions/${prediction.id}`,
      { headers: { Authorization: `Token ${REPLICATE_KEY}` } }
    );

    if (!pollRes.ok) {
      console.warn(`[Replicate poll] HTTP ${pollRes.status}`);
      break;
    }

    prediction = await pollRes.json();
    attempts++;
  }

  if (prediction.status === 'failed' || prediction.status === 'canceled') {
    throw new Error(`Replicate generation failed: ${prediction.error || 'unknown reason'}`);
  }

  if (attempts >= MAX_POLL_ATTEMPTS && prediction.status !== 'succeeded') {
    throw new Error('Replicate timed out — try a shorter prompt');
  }

  if (!prediction.output?.length) {
    throw new Error('Replicate returned no images — please try again');
  }

  return {
    images:     prediction.output,
    latency_ms: Date.now() - startTime,
    provider:   'replicate',
    model:      'sdxl-1.0',
  };
}

// ══════════════════════════════════════════════════
//  UNIFIED GENERATE FUNCTION
// ══════════════════════════════════════════════════

/**
 * Main generation function — tries Cloudflare first, falls back to Replicate.
 *
 * @param {object} options
 * @param {string} options.prompt      - user prompt text
 * @param {string} options.style       - style preset
 * @param {string} options.uid         - Firebase user UID
 * @param {boolean} options.cfOnly     - if true, never falls back to Replicate
 * @returns {{ images: string[], provider: string, latency_ms: number }}
 */
export async function generateImages({ prompt, style = 'Dark Luxury', uid = '', cfOnly = false }) {
  // ── Try Cloudflare Worker first (free tier) ──
  if (CF_WORKER_URL) {
    try {
      console.log(`[ImageService] Trying Cloudflare Worker for uid=${uid}`);
      const result = await generateWithCloudflare(prompt, style, uid);
      console.log(`[ImageService] ✅ Cloudflare success — ${result.latency_ms}ms`);
      return result;
    } catch (cfErr) {
      console.warn(`[ImageService] Cloudflare failed: ${cfErr.message}`);

      // If daily limit hit, surface error clearly (don't burn Replicate credits)
      if (cfErr.message.includes('limit') || cfErr.message.includes('quota')) {
        if (cfOnly || !REPLICATE_KEY) {
          throw new Error('Daily free generation limit reached — try again tomorrow.');
        }
      }

      if (cfOnly) {
        throw cfErr; // caller opted out of fallback
      }

      console.log('[ImageService] Falling back to Replicate...');
    }
  }

  // ── Fallback: Replicate SDXL ──
  if (REPLICATE_KEY) {
    console.log(`[ImageService] Using Replicate for uid=${uid}`);
    const result = await generateWithReplicate(prompt, style);
    console.log(`[ImageService] ✅ Replicate success — ${result.latency_ms}ms, ${result.images.length} images`);
    return result;
  }

  throw new Error(
    'No image generation service configured. Set CF_WORKER_URL or REPLICATE_API_KEY in .env'
  );
}

/** Check which providers are available */
export function getProviderStatus() {
  return {
    cloudflare: !!CF_WORKER_URL,
    replicate:  !!REPLICATE_KEY,
  };
}
