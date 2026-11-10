import { normalizeArtifactBundle, parseJsonLike } from './artifactBundle.js';
import { buildBundleDeployPlan } from './bundleDeployPlanner.js';

const object = v => v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const abortError = () => new DOMException('History request invalidated', 'AbortError');

/** getSession returns {token, key}; key must change on logout/account switch.
 * Call invalidate immediately on session changes or selection changes. Each call
 * performs one bounded server page, including empty continuation pages. */
export function createGenerationHistoryClient({ endpoint, getSession, fetchImpl = globalThis.fetch }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/service/generation-history', '/staging/service/generation-history'].includes(url.pathname)) throw new Error('Invalid history endpoint');
  let epoch = 0;
  const pending = new Set();
  function invalidate() { epoch++; for (const c of pending) c.abort(); pending.clear(); }
  async function request(body, { signal } = {}) {
    const session = getSession();
    if (!text(session?.token) || !text(session?.key)) throw new Error('Authenticated session required');
    const { token, key } = session;
    const started = epoch;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    pending.add(controller);
    const check = () => {
      const now = getSession();
      if (controller.signal.aborted || epoch !== started || now?.key !== key || now?.token !== token) throw abortError();
    };
    try {
      check();
      const response = await fetchImpl(url.href, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const data = await response.json();
      check();
      if (!response.ok) {
        const error = new Error('History request failed');
        error.status = response.status;
        error.code = data?.error?.code || 'INVALID_RESPONSE';
        throw error;
      }
      return data;
    } finally { pending.delete(controller); signal?.removeEventListener('abort', cancel); }
  }
  const validId = id => { if (!text(id) || id.length > 1500 || id.includes('/')) throw new Error('Invalid history id'); };
  return {
    invalidate,
    async list({ cursor, signal } = {}) {
      if (cursor !== undefined && (!text(cursor) || cursor.length > 8192)) throw new Error('Invalid cursor');
      const data = await request({ action: 'list', ...(cursor === undefined ? {} : { cursor }) }, { signal });
      if (!Array.isArray(data?.items) || data.items.length > 20 || !(data.nextCursor === null || (text(data.nextCursor) && data.nextCursor.length <= 8192)) || (cursor && cursor === data.nextCursor)) throw new Error('Invalid history page');
      return data;
    },
    async detail(id, options) { validId(id); const data = await request({ action: 'detail', id }, options); if (!object(data?.generation)) throw new Error('Invalid history detail'); return data; },
    async delete(id, options) { validId(id); const data = await request({ action: 'delete', id }, options); if (data?.deleted !== true || data.id !== id) throw new Error('Invalid deletion response'); return data; },
  };
}

function completeStage(stage, field) {
  const value = stage?.[`${field}_text`];
  return text(value) && stage[`${field}_truncated`] !== true && stage.status !== 'error' && stage.status !== 'failed'
    && !['length', 'max_tokens', 'content_filter'].includes(stage.finish_reason)
    && !(Number.isFinite(stage[`${field}_chars`]) && stage[`${field}_chars`] > value.length);
}
function validatedBundle(raw) {
  if (!object(raw) || !['artifact-bundle/v1'].includes(raw.schemaVersion) || !Array.isArray(raw.artifacts) || !raw.artifacts.length) return null;
  const types = ['CustomAction', 'CustomWidget', 'CustomFunction', 'CustomClass', 'CodeFile'];
  if (raw.artifacts.some(a => !object(a) || !text(a.id) || !types.includes(a.artifactType) || !text(a.artifactName) || !/^[\w-]+\.dart$/.test(a.fileName) || !text(a.code) || (a.deployPath && (a.deployPath.includes('..') || !a.deployPath.startsWith('lib/'))))) return null;
  const bundle = normalizeArtifactBundle(raw);
  if (new Set(bundle.artifacts.map(a => a.id)).size !== bundle.artifacts.length) return null;
  if (bundle.deployOrder.length !== bundle.artifacts.length || new Set(bundle.deployOrder).size !== bundle.artifacts.length || bundle.deployOrder.some(id => !bundle.artifacts.some(a => a.id === id))) return null;
  const plan = buildBundleDeployPlan(bundle);
  if (plan.errors.length) return null;
  const files = plan.fileEntries;
  // Validate actual deploy targets as well as supplied paths.
  if (files && new Set(files.map(f => f.path)).size !== files.length) return null;
  const paths = bundle.artifacts.map(a => a.deployPath || `${a.codeType}/${a.fileName}`);
  if (new Set(paths).size !== paths.length) return null;
  return bundle;
}

/** Pure recovery, never generation, deployment, or approval. Raw stage text is
 * returned for text-only display. UI must retain existing deployment gates. */
export function recoverGenerationHistory(detail) {
  const g = detail?.generation || {};
  const stages = object(g.stages) ? g.stages : {};
  const result = { availability: 'unavailable', source: null, artifactBundle: null, bundleReview: null, review: null, reviewAvailable: false, originalPrompt: null, bundleSpec: null, stages, metadata: Object.fromEntries(['id', 'request_id', 'created_at', 'updated_at', 'stage', 'status', 'is_test', 'models', 'totals'].map(k => [k, g[k] ?? null])) };
  if (detail?.identityMismatch || !text(g.id) || g.id !== g.request_id) return result;
  const architect = stages.architect, generator = stages.generator, review = stages.review;
  if (completeStage(architect, 'input')) result.originalPrompt = parseJsonLike(architect.input_text)?.userRequest ?? null;
  if (typeof result.originalPrompt !== 'string') result.originalPrompt = null;
  result.bundleSpec = completeStage(architect, 'output') ? parseJsonLike(architect.output_text) : null;
  if (!result.bundleSpec && completeStage(generator, 'input')) result.bundleSpec = parseJsonLike(generator.input_text)?.bundleSpec ?? null;
  let bundle = completeStage(generator, 'output') ? validatedBundle(parseJsonLike(generator.output_text)) : null;
  if (bundle) result.source = 'generator-output';
  if (!bundle && completeStage(review, 'input')) {
    bundle = validatedBundle(parseJsonLike(review.input_text)?.generatedBundle);
    if (bundle) result.source = 'review-input';
  }
  if (!bundle) return result;
  result.artifactBundle = bundle;
  result.availability = 'pre-review';
  const rawReview = completeStage(review, 'output') ? parseJsonLike(review.output_text) : null;
  if (!object(rawReview) || !['artifact-bundle/v1'].includes(rawReview.schemaVersion) || !Array.isArray(rawReview.artifacts)) return result;
  const summary = rawReview.bundleReview;
  if (!object(summary) || !['pass', 'warn', 'fail'].includes(summary.status) || !Number.isInteger(summary.score) || summary.score < 0 || summary.score > 100 || !text(summary.summary)) return result;
  if (rawReview.artifacts.some(a => !object(a) || !text(a.id) || !['pass', 'warn', 'fail'].includes(a.review?.status))) return result;
  const normalized = normalizeArtifactBundle(rawReview);
  const reviews = new Map(normalized.artifacts.map(a => [a.id, a.review]));
  if (reviews.size !== bundle.artifacts.length || normalized.artifacts.length !== reviews.size || bundle.artifacts.some(a => !object(reviews.get(a.id)))) return result;
  result.review = rawReview;
  result.reviewAvailable = true;
  result.availability = 'reviewed';
  result.bundleReview = { ...bundle, artifacts: bundle.artifacts.map(a => {
    const stored = reviews.get(a.id);
    return { ...a, review: stored, ...(text(stored.fixedSource) ? { fixedCode: stored.fixedSource.trim() } : {}) };
  }) };
  return result;
}
