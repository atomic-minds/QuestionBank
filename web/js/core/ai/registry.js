// Which AI provider is active is a configuration choice (AI_PROVIDER), not a code change.
// To add one: create ./yourprovider.js exporting a factory that returns an AiProvider
// (see provider.js) and add it to FACTORIES below.
import { AiError } from './provider.js';
import { createGeminiProvider } from './gemini.js';

// purpose 'read' = reading a photo (fast, light model); purpose 'solve' = writing answers and worked solutions.
// Solving may use a stronger model: set GEMINI_SOLVE_MODEL. If it is not set, GEMINI_MODEL is used for both.
const FACTORIES = {
  gemini: (env, fetchImpl, purpose) => createGeminiProvider({
    apiKey: env('GEMINI_API_KEY'),
    model: (purpose === 'solve' && env('GEMINI_SOLVE_MODEL')) || env('GEMINI_MODEL'),
    fetchImpl,
  }),
};

export const PROVIDER_IDS = Object.keys(FACTORIES);

/** @param {(name:string)=>string|undefined} env */
export function getProvider(env, fetchImpl, purpose = 'read') {
  const id = (env('AI_PROVIDER') || 'gemini').toLowerCase();
  const factory = FACTORIES[id];
  if (!factory) throw new AiError('AI_NOT_CONFIGURED', `Unknown AI_PROVIDER "${id.slice(0, 30)}". Available: ${PROVIDER_IDS.join(', ')}.`);
  return factory(env, fetchImpl, purpose);
}

/** Cheap check used before spending any quota. */
export function aiStatus(env) {
  try {
    const p = getProvider(env);
    return { configured: true, provider: p.id, model: p.model, solve_model: getProvider(env, undefined, 'solve').model };
  } catch (e) {
    return { configured: false, provider: (env('AI_PROVIDER') || 'gemini').toLowerCase(), model: null, reason: e.message };
  }
}
