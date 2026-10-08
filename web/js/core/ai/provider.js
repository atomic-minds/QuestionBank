// The contract every AI provider implements. Adding a provider means writing one file with a
// `create…Provider()` function and listing it in registry.js — nothing else in the app changes.
import { AppError } from '../errors.js';

/**
 * @typedef {Object} ExtractRequest
 * @property {{mimeType: string, bytes: Uint8Array}} image   held in memory for this request only
 * @property {string} system        instructions
 * @property {string} userText      the user turn that accompanies the image
 * @property {object} schema        Gemini-style response schema (see schema.js)
 * @property {AbortSignal} [signal]
 *
 * @typedef {Object} AiProvider
 * @property {string} id
 * @property {string} model
 * @property {(req: ExtractRequest) => Promise<{json: any, usage?: any}>} extract
 */

/** Errors callers can show verbatim. `code` is one of the AI_* codes in errors.js. */
export class AiError extends AppError {
  constructor(code, message, details) {
    super(code, message, { details });
    this.name = 'AiError';
  }
}

/** Base64 for a byte array without blowing the call stack on multi-megabyte images. */
export function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
