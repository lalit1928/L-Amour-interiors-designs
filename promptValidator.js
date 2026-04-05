/**
 * utils/promptValidator.js
 * ─────────────────────────
 * Shared prompt validation and sanitisation utilities.
 * Used by server.js API routes.
 */

const MIN_LEN = 5;
const MAX_LEN = 800;

/**
 * Validates and sanitises a user prompt.
 *
 * @param {string} prompt
 * @returns {{ ok: boolean, error?: string, sanitised?: string }}
 */
export function validatePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, error: 'Prompt is required' };
  }

  const sanitised = prompt
    .trim()
    .replace(/<[^>]*>/g, '')          // strip HTML tags
    .replace(/[^\w\s\-.,!?'"()&]/g, ' ')  // remove unusual chars
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim();

  if (sanitised.length < MIN_LEN) {
    return { ok: false, error: `Prompt must be at least ${MIN_LEN} characters` };
  }

  if (sanitised.length > MAX_LEN) {
    return { ok: false, error: `Prompt too long — keep it under ${MAX_LEN} characters` };
  }

  // Basic content filter — block obviously harmful prompts
  const blocked = ['nude', 'naked', 'explicit', 'nsfw', 'porn', 'sex'];
  if (blocked.some(w => sanitised.toLowerCase().includes(w))) {
    return { ok: false, error: 'Prompt contains disallowed content' };
  }

  return { ok: true, sanitised };
}

/**
 * Valid style preset names.
 */
export const VALID_STYLES = [
  'Dark Luxury', 'Minimalist', 'Cyberpunk',
  'Realistic', 'Wabi-Sabi', 'Art Deco',
];

/**
 * Validates a style preset name.
 * Falls back to 'Dark Luxury' if invalid.
 */
export function validateStyle(style) {
  if (typeof style === 'string' && VALID_STYLES.includes(style)) {
    return style;
  }
  return 'Dark Luxury'; // safe default
}
