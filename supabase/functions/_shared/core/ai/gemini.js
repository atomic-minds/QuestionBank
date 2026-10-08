// Google Gemini provider (generateContent REST endpoint, free tier friendly).
//
// - The API key stays on the server (Supabase Edge Function secret); it travels in a header, never
//   in a URL, and never appears in any error message.
// - The image is sent inline and is not stored anywhere by this app.
// - One call per image. There is no automatic retry: a retry would burn the free quota twice.
import { AiError, toBase64 } from './provider.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/;

/**
 * @param {{apiKey: string, model: string, baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch}} cfg
 * @returns {import('./provider.js').AiProvider}
 */
export function createGeminiProvider(cfg) {
  const model = String(cfg.model ?? '').replace(/^models\//, '');
  if (!cfg.apiKey || !MODEL_PATTERN.test(model)) {
    throw new AiError('AI_NOT_CONFIGURED', 'Gemini is not configured: set GEMINI_API_KEY and GEMINI_MODEL.');
  }
  const base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 60_000;

  return {
    id: 'gemini',
    model,
    async extract({ image, system, userText, schema, signal }) {
      // Google sometimes rejects a schema style with a bare "invalid argument" (it differs between model
      // generations). So on that exact error we retry with a simpler request: first the standard JSON
      // Schema field, then no schema at all (the schema is described in the prompt and the answer is still
      // fully re-checked by this app). A rejected request is not charged against the free quota.
      const variants = [
        { name: 'schema', gen: { responseSchema: schema }, text: userText },
        { name: 'json-schema', gen: { responseJsonSchema: toJsonSchema(schema) }, text: userText },
        { name: 'prompt', gen: {}, text: `${userText}\n\nAnswer with ONLY a JSON object that follows this JSON Schema:\n${JSON.stringify(toJsonSchema(schema))}` },
      ];
      const buildBody = (v) => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: image.mimeType, data: toBase64(image.bytes) } },
            { text: v.text },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          ...v.gen,
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
      });

      for (let i = 0; i < variants.length; i++) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout;
        let res;
        try {
          res = await doFetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
            body: JSON.stringify(buildBody(variants[i])),
            signal: combined,
          });
        } catch (e) {
          if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new AiError('AI_TIMEOUT', 'The AI took too long to respond. Try again, or use a smaller image.');
          }
          throw new AiError('AI_UNAVAILABLE', 'Could not reach the AI service. Try again in a moment.');
        }

        let payload = null;
        const rawText = await res.text();
        try { payload = JSON.parse(rawText); } catch { /* non-JSON body */ }

        if (!res.ok) {
          const bareInvalid = res.status === 400 && /invalid argument/i.test(providerMessage(payload) ?? '') && !/api key/i.test(providerMessage(payload) ?? '');
          if (bareInvalid && i < variants.length - 1) continue;
          throw mapHttpError(res, payload);
        }
        return parseSuccess(payload);
      }
      throw new AiError('AI_UNAVAILABLE', 'The AI service is having trouble right now. Try again shortly.');
    },
  };
}

// Gemini-style schema (UPPERCASE types, nullable) -> standard JSON Schema (lowercase, type arrays).
function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'propertyOrdering' || k === 'nullable') continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([n, c]) => [n, toJsonSchema(c)])) : toJsonSchema(v);
  }
  if (typeof out.type === 'string') {
    out.type = out.type.toLowerCase();
    if (node.nullable) out.type = [out.type, 'null'];
  }
  if (node.nullable && Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  return out;
}

function providerMessage(payload) {
  const m = payload?.error?.message;
  return typeof m === 'string' ? m.replace(/key=[^&\s]+/gi, 'key=***').slice(0, 300) : undefined;
}

function mapHttpError(res, payload) {
  const status = res.status;
  const pm = providerMessage(payload);
  const details = pm ? { provider_message: pm } : undefined;
  if (status === 429) {
    return new AiError('AI_QUOTA_EXHAUSTED',
      'The free Gemini usage limit has been reached for now. Wait a while (daily limits reset every day) and try again, or use Import JSON instead. On the free tier nothing is charged; keep billing switched off.',
      { ...details, retry_after: res.headers.get('retry-after') ?? undefined });
  }
  if (status === 400 && /api key/i.test(pm ?? '')) return new AiError('AI_NOT_CONFIGURED', 'Google rejected the API key. Check the GEMINI_API_KEY secret.', details);
  if (status === 401 || status === 403) return new AiError('AI_NOT_CONFIGURED', 'Google rejected the API key or it is not allowed to use this model. Check GEMINI_API_KEY.', details);
  if (status === 404) return new AiError('AI_NOT_CONFIGURED', 'Google does not know that model name. Check the GEMINI_MODEL secret.', details);
  if (status === 400) return new AiError('AI_UNAVAILABLE', 'Google rejected the request. The image may be unsupported; try another one.', details);
  return new AiError('AI_UNAVAILABLE', 'The AI service is having trouble right now. Try again shortly.', details);
}

function parseSuccess(payload) {
  const block = payload?.promptFeedback?.blockReason;
  if (block) throw new AiError('AI_BLOCKED', 'The AI declined to read this image. Try a different image, or use Import JSON.');

  const cand = payload?.candidates?.[0];
  const finish = cand?.finishReason;
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(finish)) {
    throw new AiError('AI_BLOCKED', 'The AI declined to answer for this image. Try a different image, or use Import JSON.');
  }
  const text = (cand?.content?.parts ?? []).filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (finish === 'MAX_TOKENS' && !text) throw new AiError('AI_BAD_OUTPUT', 'The answer was too long. Use a smaller crop with fewer questions.');
  if (!text) throw new AiError('AI_BAD_OUTPUT', 'The AI returned nothing. Try again, or use Import JSON.');

  let json;
  try { json = JSON.parse(text); } catch {
    throw new AiError('AI_BAD_OUTPUT', finish === 'MAX_TOKENS'
      ? 'The answer was cut off because it was too long. Use a smaller crop with fewer questions.'
      : 'The AI answered with malformed JSON. Try again, or use Import JSON.');
  }
  return { json, usage: payload?.usageMetadata };
}
