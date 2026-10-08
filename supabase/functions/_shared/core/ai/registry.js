// Which AI provider is active is a configuration choice (AI_PROVIDER), not a code change.
// To add one: create ./yourprovider.js exporting a factory that returns an AiProvider
// (see provider.js) and add it to FACTORIES below.
import { AiError } from './provider.js';
import { createGeminiProvider } from './gemini.js';

const FACTORIES = {
  gemini: (env, fetchImpl) => createGeminiProvider({
    apiKey: env('GEMINI_API_KEY'), model: env('GEMINI_MODEL'), fetchImpl,
  }),
};

export const PROVIDER_IDS = Object.keys(FACTORIES);

/** @param {(name:string)=>string|undefined} env */
export function getProvider(env, fetchImpl) {
  const id = (env('AI_PROVIDER') || 'gemini').toLowerCase();
  const factory = FACTORIES[id];
  if (!factory) throw new AiError('AI_NOT_CONFIGURED', `Unknown AI_PROVIDER "${id.slice(0, 30)}". Available: ${PROVIDER_IDS.join(', ')}.`);
  return factory(env, fetchImpl);
}

/** Cheap check used before spending any quota. */
export function aiStatus(env) {
  try {
    const p = getProvider(env);
    return { configured: true, provider: p.id, model: p.model };
  } catch (e) {
    return { configured: false, provider: (env('AI_PROVIDER') || 'gemini').toLowerCase(), model: null, reason: e.message };
  }
}
