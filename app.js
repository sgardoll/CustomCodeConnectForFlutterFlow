import posthog from "posthog-js";
import {
  closeModal,
  initializeModalShells,
  openModal,
  setModalPending,
} from "./src/sharedControls.js";
import {
  PLAN_LABELS as planLabels,
  PLAN_LIMITS as planLimits,
  PLAN_FEATURES as planFeatures,
} from "./src/plansSurface.js";
import {
  getPrimaryArtifact,
  normalizeArtifactBundle,
} from "./src/artifactBundle.js";
import {
  buildArchitectPrompt,
  buildArtifactRegenerationPrompt,
  buildBundleRegenerationPrompt,
  buildGeneratorPrompt,
  buildReviewPrompt,
  createBuildShipContext,
} from "./src/pipelineContracts.js";
import { createModelArmorError } from "./src/modelArmorResponse.js";
import {
  getDeclaredDartTypes,
  validateBundleCompatibility,
} from "./src/flutterFlowArtifactValidation.js";
import { applyFlutterFlowHeader } from "./src/flutterFlowHeader.js";
import { buildBundleDeployPlan } from "./src/bundleDeployPlanner.js";
import {
  excludeProvisionedCodeFiles,
  findMissingCodeFiles,
} from "./src/flutterFlowCodeFileProvisioning.js";
import { buildReviewPresentation } from "./src/reviewPresentation.js";
import {
  expectedWidgetClassFromFileName,
  findUnbalancedBracketError,
  getDeclaredWidgetClasses,
  sanitizeGeneratedDart,
  widgetFileNameForClass,
} from "./src/flutterFlowCodeSanitizer.js";
import { formatFlutterFlowFileError } from "./src/flutterFlowFileErrors.js";
import { extractPackageImports } from "./src/dartPackageImports.js";
import {
  explainPlusAliasRule,
  getMagicLinkResultMessage,
  isKnownProviderPlusAlias,
  PLUS_ALIAS_REJECTED_CODE,
  trimEmail,
} from "./src/authMagicLink.js";
import { planCustomCodeVerification } from "./src/customCodeVerification.js";
import {
  deployOutcomeOfStreamResult,
  readProvisionResponse,
} from "./src/provisionStream.js";
import {
  classifyDeployResult,
  DeployOutcome,
  DEPLOY_UI_TIMEOUT_MS,
} from "./src/deployOutcome.js";
import { buildFlutterFlowSyncMetadata } from "./src/flutterFlowSyncMetadata.js";
import { initHeroMarkField } from "./src/heroMarkField.js";
import {
  applyDependencyOverrides,
  mergeDependenciesIntoYaml,
  validateProjectPubspec,
} from "./src/pubspecSync.js";
import { planDependencyChanges } from "./src/dependencyResolution.js";
import { escapeAttr, escapeHtml, escapeHtmlText } from "./src/htmlEscape.js";
import { resolvePipelineErrorStep, classifyPipelineError } from "./src/pipelineErrors.js";
import {
  extractCodeFromMarkdown,
  highlightCode,
  renderMarkdownAudit,
} from "./src/auditRenderer.js";

// --- CONFIGURATION ---
const IS_DEV = import.meta.env.DEV
const FLUTTERFLOW_CLASS_PROVISION_ENDPOINT =
  import.meta.env.VITE_FLUTTERFLOW_CLASS_PROVISION_ENDPOINT ||
  import.meta.env.VITE_FLUTTERFLOW_DSL_DEPLOY_ENDPOINT ||
  "https://ccc-ffai-runner-y5cyj3473a-uw.a.run.app/deployCustomClasses";

// --- ANALYTICS ---
const POSTHOG_KEY = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';

if (POSTHOG_KEY) {
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    person_profiles: 'identified_only'
  });
}

function trackEvent(eventName, properties = {}) {
  if (POSTHOG_KEY) {
    try {
      posthog.capture(eventName, properties);
    } catch(e) {
      console.error("PostHog tracking failed", e);
    }
  }
}

// --- AUTH / SUBSCRIPTION CONFIG ---
const BUILDSHIP_BASE_URL = 'https://4tgke4.buildship.run'
const STRIPE_PRICE_IDS = {
  professional: 'price_1T2ldCKszA2slvDXatdeCpbI',
  power: 'price_1T2le9KszA2slvDXR4mPvw7M'
}

const AUTH_SESSION_STORAGE_KEY = 'ccc_auth_session'
// Where the user asked to sign in from (composer, plans, billing…), so a
// magic-link round trip — which reloads the page with no memory of the DOM —
// can return them to that surface instead of always landing on home.
const SIGNIN_RETURN_STORAGE_KEY = 'ccc_signin_return'
const SIGNIN_RETURN_TTL_MS = 30 * 60 * 1000

const proGateAttachedSet = new WeakSet()

let authState = {
  email: null,
  sessionToken: null,
  isVerified: false,
}

function createSubscriptionState(overrides = {}) {
  return {
    tier: 'free',
    status: 'none',
    periodEnd: null,
    isLoading: false,
    isResolved: false,
    error: null,
    ...overrides,
  }
}

let subscriptionState = createSubscriptionState({ isResolved: true })

// --- PIPELINE ---
const PIPELINE_ENDPOINT = `${BUILDSHIP_BASE_URL}/service/runpipeline`

// --- IDENTITY RESOLUTION ---
const IDENTITY_COOKIE_KEY = 'bs_identity'
const IDENTITY_SESSION_KEY = 'bs_user_id'
const IDENTITY_TOKEN_KEY = 'bs_identity_token'
const IDENTITY_ENDPOINT = `${BUILDSHIP_BASE_URL}/authUserCheck`

let identityState = {
  userId: null,
  token: null,
  status: null, // 'recognized' | 'new' | null
  resolved: false,
}

// --- TIER LIMITS ---
// Single source of truth in src/plansSurface.js so the plans page, the
// paywall and generation gating agree (STU-382 criterion 1).
const TIER_LIMITS = planLimits;

const SUBSCRIPTION_CACHE_KEY = 'ccc_subscription'
const SUBSCRIPTION_CACHE_VERSION = 3
const PAID_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'paid'])

const FREE_MODEL = 'google/gemini-3.7-flash'
const PRO_MODELS = [
  'anthropic/claude-opus-5',
  'openai/gpt-5.6-sol',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k3',
  'openrouter/auto-beta',
  'openrouter/free',
  'openrouter/deepseek/deepseek-v4-pro',
]

// Display names for every selectable model. Keep in sync with the
// #code-generator-model options in index.html.
const MODEL_LABELS = {
  'google/gemini-3.7-flash': 'Gemini 3.7 Flash',
  'anthropic/claude-opus-5': 'Claude Opus 5',
  'openai/gpt-5.6-sol': 'GPT-5.6 Sol',
  'z-ai/glm-5.2': 'GLM 5.2',
  'moonshotai/kimi-k3': 'Kimi K3',
  'openrouter/auto-beta': 'OpenRouter: Auto Router',
  'openrouter/free': 'OpenRouter: Free Models',
  'openrouter/deepseek/deepseek-v4-pro': 'DeepSeek v4 Pro',
}

function getModelLabel(model) {
  return MODEL_LABELS[model] || model
}

// Models whose image input is supported. Users can attach images to their
// prompt only when the selected model accepts vision through OpenRouter.
const IMAGE_SUPPORTED_MODELS = new Set([
  'google/gemini-3.7-flash',
  'anthropic/claude-opus-5',
  'openai/gpt-5.6-sol',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k3',
  'openrouter/auto-beta',
])

function modelSupportsImages(model) {
  return IMAGE_SUPPORTED_MODELS.has(model)
}

const MAX_PROMPT_IMAGES = 4
// Keep incoming files bounded so uploads stay quick. 8 MB per file is generous.
const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024
const PIPELINE_IMAGE_ENDPOINT =
  "https://4tgke4.buildship.run/service/runpipeline-image"
// Attached prompt images. Each item holds a local dataUrl (for the thumbnail
// preview) plus the uploaded url returned by the image endpoint — the url is
// what actually gets sent to the pipeline.
let promptImages = [] // Array of { dataUrl, name, url }

function readAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

// Uploads one image file to the BuildShip image endpoint. The endpoint is
// called separately from the pipeline so we pass real URLs, not base64.
async function uploadPromptImage(file) {
  const formData = new FormData()
  formData.append("file", file)
  const res = await fetch(PIPELINE_IMAGE_ENDPOINT, {
    method: "POST",
    body: formData,
  })
  return res.json()
}

// Normalises an uploaded file object into a URL string. The image endpoint
// returns an ARRAY of per-file results, e.g.
//   [{ item: {...file meta...}, index: 0, "<workflow-uuid>": { type: "external-url", file: "https://..." } }]
// The external URL is under the entry's non-item/non-index key → .file.
function uploadedFileUrl(uploaded) {
  if (Array.isArray(uploaded)) {
    const first = uploaded[0]
    if (first && typeof first === "object") {
      for (const key of Object.keys(first)) {
        if (key === "item" || key === "index") continue
        const entry = first[key]
        if (entry && typeof entry === "object") {
          if (typeof entry.file === "string") return entry.file
          if (typeof entry.url === "string") return entry.url
        }
        if (typeof entry === "string") return entry
      }
    }
    return ""
  }
  if (typeof uploaded === "string") return uploaded
  if (uploaded && typeof uploaded === "object") {
    return (
      uploaded.url ||
      uploaded.fileUrl ||
      uploaded.file_url ||
      uploaded.downloadUrl ||
      uploaded.imageUrl ||
      uploaded.image_url ||
      uploaded.file ||
      ""
    )
  }
  return ""
}

async function handlePromptImageSelect(event) {
  const files = Array.from(event.target.files || [])
  if (!files.length) return

  // Drop oversized files up front rather than uploading/reading them.
  const oversized = files.filter((f) => f.size > MAX_PROMPT_IMAGE_BYTES)
  if (oversized.length) {
    showToast(
      `Skipped ${oversized.length} image(s) over the ${(MAX_PROMPT_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MB limit.`,
      "warning",
    )
  }
  const validFiles = files.filter((f) => f.size <= MAX_PROMPT_IMAGE_BYTES)
  if (!validFiles.length) {
    event.target.value = ""
    return
  }

  const remaining = MAX_PROMPT_IMAGES - promptImages.length
  const toAdd = validFiles.slice(0, remaining)

  const jobs = toAdd.map(async (file) => {
    const dataUrl = await readAsDataUrl(file)
    if (!dataUrl) return null
    let url = ""
    try {
      url = uploadedFileUrl(await uploadPromptImage(file))
    } catch (e) {
      url = ""
    }
    return { dataUrl, name: file.name, url }
  })

  const added = (await Promise.all(jobs)).filter(Boolean)
  event.target.value = ""
  // A non-vision model may have been selected while uploading; don't restore
  // images that the model-change handler cleared.
  if (
    added.length &&
    !modelSupportsImages(
      document.getElementById("code-generator-model")?.value,
    )
  ) {
    return
  }
  promptImages.push(...added)
  if (validFiles.length > remaining) {
    showToast(`You can attach up to ${MAX_PROMPT_IMAGES} images.`, "info")
  }
  renderPromptImages()
}

function removePromptImage(index) {
  promptImages.splice(index, 1)
  renderPromptImages()
}

function renderPromptImages() {
  const container = document.getElementById("prompt-image-thumbnails")
  const label = document.getElementById("prompt-image-btn-label")
  if (!container) return

  container.innerHTML = ""
  promptImages.forEach((img, i) => {
    const el = document.createElement("div")
    el.className = "prompt-img-thumb"
    el.innerHTML =
      `<img src="${escapeAttr(img.dataUrl)}" alt="Prompt image">` +
      `<button type="button" class="prompt-img-remove" title="Remove image" onclick="removePromptImage(${i})">×</button>`
    container.appendChild(el)
  })

  if (label) {
    label.textContent =
      promptImages.length >= MAX_PROMPT_IMAGES ? "Image limit reached" : "Add images"
  }
}

function updatePromptImageAvailability() {
  const section = document.getElementById("prompt-image-upload")
  if (!section) return
  const select = document.getElementById("code-generator-model")
  const supports = modelSupportsImages(select?.value)
  section.classList.toggle("hidden", !supports)
  // Non-vision models have no way to consume images: drop any already attached.
  if (!supports && promptImages.length) {
    promptImages = []
    renderPromptImages()
  }
}

const USAGE_STORAGE_KEY = 'ccc_usage'

// Model Configuration
const PROMPT_ARCHITECT_MODEL = "google/gemini-3.7-flash"
const CODE_REVIEW_MODEL = "google/gemini-3.7-flash"
const FALLBACK_MODEL = "google/gemini-3.7-flash"

// --- DYNAMIC PRICING ---
const BASE_PRICES_AUD = { professional: 11, power: 49 }

const LOCALE_CURRENCY_MAP = {
  en_US: 'USD', en_GB: 'GBP', en_AU: 'AUD', en_NZ: 'NZD', en_CA: 'CAD',
  en_IN: 'INR', en_SG: 'SGD', en_HK: 'HKD', en_PH: 'PHP', en_ZA: 'ZAR',
  en: 'USD',
  de: 'EUR', fr: 'EUR', es: 'EUR', it: 'EUR', nl: 'EUR', pt_PT: 'EUR',
  pt_BR: 'BRL', pt: 'BRL',
  ja: 'JPY', ko: 'KRW', zh_CN: 'CNY', zh_TW: 'TWD', zh: 'CNY',
  th: 'THB', vi: 'VND', id: 'IDR', ms_MY: 'MYR', ms: 'MYR',
  sv: 'SEK', nb: 'NOK', da: 'DKK', pl: 'PLN', cs: 'CZK',
  hu: 'HUF', ro: 'RON', tr: 'TRY',
  ar: 'AED', he: 'ILS', ru: 'RUB', uk: 'UAH',
}

const AUD_EXCHANGE_RATES_FALLBACK = {
  AUD: 1, USD: 0.65, EUR: 0.60, GBP: 0.52, CAD: 0.88,
  NZD: 1.08, JPY: 97, KRW: 870, INR: 54, SGD: 0.87,
  HKD: 5.08, BRL: 3.18, CNY: 4.70, TWD: 20.5, THB: 22.5,
  VND: 16200, IDR: 10200, MYR: 2.88, SEK: 6.80, NOK: 6.95,
  DKK: 4.48, PLN: 2.60, CZK: 15.2, HUF: 238, RON: 2.98,
  TRY: 20.9, AED: 2.39, ILS: 2.38, PHP: 36.4, ZAR: 11.8,
  RUB: 58, UAH: 26.8, CHF: 0.57, MXN: 11.1, ARS: 580,
  CLP: 610, COP: 2700, PEN: 2.44,
}

let AUD_EXCHANGE_RATES = { ...AUD_EXCHANGE_RATES_FALLBACK }

async function fetchAudExchangeRates() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/AUD', { signal: controller.signal })
    if (!res.ok) return
    const data = await res.json()
    if (data.result !== 'success' || !data.rates) return
    const rates = data.rates
    const updated = { AUD: 1 }
    const allCurrencies = new Set([
      ...Object.keys(AUD_EXCHANGE_RATES_FALLBACK),
      ...Object.values(TIMEZONE_CURRENCY_MAP),
      ...Object.values(LOCALE_CURRENCY_MAP),
    ])
    for (const code of allCurrencies) {
      if (code === 'AUD') continue
      if (typeof rates[code] === 'number' && rates[code] > 0) {
        updated[code] = rates[code]
      } else if (AUD_EXCHANGE_RATES_FALLBACK[code]) {
        updated[code] = AUD_EXCHANGE_RATES_FALLBACK[code]
      }
    }
    AUD_EXCHANGE_RATES = updated
  } catch {
  } finally {
    clearTimeout(timeout)
  }
}

const TIMEZONE_CURRENCY_MAP = {
  'America/Sao_Paulo': 'BRL', 'America/Fortaleza': 'BRL', 'America/Recife': 'BRL',
  'America/Bahia': 'BRL', 'America/Belem': 'BRL', 'America/Manaus': 'BRL',
  'America/Cuiaba': 'BRL', 'America/Campo_Grande': 'BRL', 'America/Araguaina': 'BRL',
  'America/Noronha': 'BRL', 'America/Rio_Branco': 'BRL', 'America/Porto_Velho': 'BRL',
  'America/Boa_Vista': 'BRL', 'America/Maceio': 'BRL', 'America/Santarem': 'BRL',
  'America/Eirunepe': 'BRL',
  'Europe/London': 'GBP', 'Europe/Paris': 'EUR', 'Europe/Berlin': 'EUR',
  'Europe/Madrid': 'EUR', 'Europe/Rome': 'EUR', 'Europe/Amsterdam': 'EUR',
  'Europe/Brussels': 'EUR', 'Europe/Vienna': 'EUR', 'Europe/Lisbon': 'EUR',
  'Europe/Dublin': 'EUR', 'Europe/Helsinki': 'EUR', 'Europe/Athens': 'EUR',
  'Europe/Bucharest': 'RON', 'Europe/Budapest': 'HUF', 'Europe/Warsaw': 'PLN',
  'Europe/Prague': 'CZK', 'Europe/Copenhagen': 'DKK', 'Europe/Stockholm': 'SEK',
  'Europe/Oslo': 'NOK', 'Europe/Zurich': 'CHF', 'Europe/Istanbul': 'TRY',
  'Europe/Moscow': 'RUB', 'Europe/Kiev': 'UAH', 'Europe/Kyiv': 'UAH',
  'Asia/Tokyo': 'JPY', 'Asia/Seoul': 'KRW', 'Asia/Shanghai': 'CNY',
  'Asia/Taipei': 'TWD', 'Asia/Hong_Kong': 'HKD', 'Asia/Singapore': 'SGD',
  'Asia/Kolkata': 'INR', 'Asia/Calcutta': 'INR', 'Asia/Bangkok': 'THB',
  'Asia/Ho_Chi_Minh': 'VND', 'Asia/Jakarta': 'IDR', 'Asia/Kuala_Lumpur': 'MYR',
  'Asia/Dubai': 'AED', 'Asia/Jerusalem': 'ILS', 'Asia/Tel_Aviv': 'ILS',
  'Asia/Manila': 'PHP',
  'Pacific/Auckland': 'NZD',
  'Australia/Sydney': 'AUD', 'Australia/Melbourne': 'AUD', 'Australia/Brisbane': 'AUD',
  'Australia/Perth': 'AUD', 'Australia/Adelaide': 'AUD', 'Australia/Hobart': 'AUD',
  'Australia/Darwin': 'AUD', 'Australia/Lord_Howe': 'AUD',
  'America/Toronto': 'CAD', 'America/Vancouver': 'CAD', 'America/Edmonton': 'CAD',
  'America/Winnipeg': 'CAD', 'America/Halifax': 'CAD', 'America/St_Johns': 'CAD',
  'America/Regina': 'CAD',
  'America/New_York': 'USD', 'America/Chicago': 'USD', 'America/Denver': 'USD',
  'America/Los_Angeles': 'USD', 'America/Phoenix': 'USD', 'America/Anchorage': 'USD',
  'Pacific/Honolulu': 'USD',
  'America/Mexico_City': 'MXN', 'America/Cancun': 'MXN', 'America/Tijuana': 'MXN',
  'America/Argentina/Buenos_Aires': 'ARS',
  'America/Santiago': 'CLP', 'America/Bogota': 'COP', 'America/Lima': 'PEN',
  'Africa/Johannesburg': 'ZAR',
}

function detectUserCurrency() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz && TIMEZONE_CURRENCY_MAP[tz]) return TIMEZONE_CURRENCY_MAP[tz]
  } catch {}
  const locale = navigator.language || 'en-US'
  const normalized = locale.replace('-', '_')
  const exactMatch = LOCALE_CURRENCY_MAP[normalized]
  if (exactMatch) return exactMatch
  const langOnly = normalized.split('_')[0]
  const langMatch = LOCALE_CURRENCY_MAP[langOnly]
  if (langMatch) return langMatch
  return 'USD'
}

function formatPrice(audAmount, currency) {
  const rate = AUD_EXCHANGE_RATES[currency] ?? AUD_EXCHANGE_RATES.USD
  const converted = audAmount * rate
  const rounded = Math.round(converted * 100) / 100
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: rounded >= 100 ? 0 : rounded % 1 === 0 ? 0 : 2,
    }).format(rounded)
  } catch {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(audAmount * AUD_EXCHANGE_RATES.USD)
  }
}

// --- SECURE STORAGE (AES-256-GCM encryption) ---
const STORAGE_KEY_PREFIX = "ccc_api_key_";
const SESSION_STORAGE_KEY_PREFIX = "ccc_session_api_key_";
const ENCRYPTION_KEY_NAME = "ccc_encryption_key";
const SESSION_KEY_SCOPE_NAME = "ccc_encryption_key_scope";
const KEY_DB_NAME = "ccc_keystore";
const KEY_DB_STORE = "keys";
const KEY_VERSION_NAME = "ccc_encryption_key_version";
/** @type {Promise<CryptoKey> | null} */
let encryptionKeyPromise = null;
let cachedEncryptionKeyVersion = null;
let usingSessionKeyFallback = false;
let sessionFallbackSupportsDurableCredentials = false;
let keyStorageWarningShown = false;

class CredentialStorageUnavailableError extends Error {
  constructor() {
    super("Secure browser key storage is unavailable.");
    this.name = "CredentialStorageUnavailableError";
  }
}

function notifyKeyStorageFallback() {
  if (keyStorageWarningShown) return;
  keyStorageWarningShown = true;
  const message =
    "Secure browser key storage is unavailable. Existing credentials were left untouched; new credentials will be available only in this tab session.";
  console.warn(message);
  if (document.body) showToast(message, "warning");
}

function currentEncryptionKeyVersion() {
  return localStorage.getItem(KEY_VERSION_NAME) || "";
}

function newEncryptionKeyVersion() {
  return crypto.randomUUID?.()
    || arrayBufferToBase64(crypto.getRandomValues(new Uint8Array(16)));
}

function ensureEncryptionKeyVersion() {
  const current = currentEncryptionKeyVersion();
  if (current) return current;
  const created = newEncryptionKeyVersion();
  localStorage.setItem(KEY_VERSION_NAME, created);
  return created;
}

function invalidateEncryptionKeyCache() {
  encryptionKeyPromise = null;
  cachedEncryptionKeyVersion = null;
  usingSessionKeyFallback = false;
  sessionFallbackSupportsDurableCredentials = false;
}

window.addEventListener("storage", (event) => {
  if (event.key === KEY_VERSION_NAME) invalidateEncryptionKeyCache();
});

// IndexedDB can persist a CryptoKey object without exposing its raw bytes.
// This prevents an injected script from exporting the key for offline use.
// It does not let browser storage survive arbitrary same-origin script: XSS
// could still ask Web Crypto to decrypt while it is running.
/** @returns {Promise<IDBDatabase>} */
function openKeyDatabase() {
  return /** @type {Promise<IDBDatabase>} */ (new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_DB_STORE)) {
        db.createObjectStore(KEY_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

/**
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} operation
 * @returns {Promise<T>}
 */
async function runKeyDatabaseRequest(mode, operation) {
  const db = /** @type {IDBDatabase} */ (await openKeyDatabase());
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(KEY_DB_STORE, mode);
    let request;
    try {
      request = operation(transaction.objectStore(KEY_DB_STORE));
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    let result;

    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Encryption key transaction failed."));
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error || new Error("Encryption key transaction aborted."));
    };
  });
}

/** @param {unknown} key */
function isUsableEncryptionKey(key) {
  return key instanceof CryptoKey
    && key.algorithm?.name === "AES-GCM"
    && key.extractable === false
    && key.usages.includes("encrypt")
    && key.usages.includes("decrypt");
}

/** @returns {Promise<CryptoKey | null>} */
async function loadStoredEncryptionKey() {
  const key = await runKeyDatabaseRequest("readonly", (store) =>
    store.get(ENCRYPTION_KEY_NAME),
  );
  return isUsableEncryptionKey(key) ? key : null;
}

/** @param {CryptoKey} key */
async function persistEncryptionKey(key) {
  await runKeyDatabaseRequest("readwrite", (store) =>
    store.put(key, ENCRYPTION_KEY_NAME),
  );
}

async function deleteStoredEncryptionKey() {
  invalidateEncryptionKeyCache();
  try {
    await runKeyDatabaseRequest("readwrite", (store) =>
      store.delete(ENCRYPTION_KEY_NAME),
    );
  } catch (error) {
    console.warn("Could not delete the stored encryption key:", error);
  }
}

// Re-import an earlier sessionStorage JWK as non-extractable before removing
// the exportable copy. This keeps existing encrypted credentials readable.
/** @returns {Promise<CryptoKey | null>} */
async function migrateLegacySessionKey() {
  const legacy = sessionStorage.getItem(ENCRYPTION_KEY_NAME);
  if (!legacy) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(legacy),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await persistEncryptionKey(key);

  // The legacy JWK is the only recovery path until the IndexedDB write has
  // committed successfully.
  sessionStorage.removeItem(ENCRYPTION_KEY_NAME);
  sessionStorage.removeItem(SESSION_KEY_SCOPE_NAME);
  localStorage.removeItem(STORAGE_KEY_PREFIX + "salt");
  return key;
}

/**
 * @param {boolean} allowCreation
 * @returns {Promise<CryptoKey>}
 */
async function resolveSessionEncryptionKey(allowCreation) {
  const stored = sessionStorage.getItem(ENCRYPTION_KEY_NAME);
  if (stored) {
    sessionFallbackSupportsDurableCredentials =
      sessionStorage.getItem(SESSION_KEY_SCOPE_NAME) !== "session";
    return crypto.subtle.importKey(
      "jwk",
      JSON.parse(stored),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  if (!allowCreation) throw new CredentialStorageUnavailableError();

  const exportableKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", exportableKey);
  sessionStorage.setItem(ENCRYPTION_KEY_NAME, JSON.stringify(jwk));
  sessionStorage.setItem(SESSION_KEY_SCOPE_NAME, "session");
  sessionFallbackSupportsDurableCredentials = false;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * @param {boolean} allowSessionFallbackCreation
 * @returns {Promise<CryptoKey>}
 */
async function resolveEncryptionKey(allowSessionFallbackCreation) {
  if (
    sessionStorage.getItem(SESSION_KEY_SCOPE_NAME) === "session"
    && sessionStorage.getItem(ENCRYPTION_KEY_NAME)
  ) {
    notifyKeyStorageFallback();
    usingSessionKeyFallback = true;
    return resolveSessionEncryptionKey(allowSessionFallbackCreation);
  }

  try {
    const stored = await loadStoredEncryptionKey();
    if (stored) return stored;

    const migrated = await migrateLegacySessionKey();
    if (migrated) return migrated;

    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await persistEncryptionKey(key);
    return key;
  } catch (error) {
    console.warn("IndexedDB encryption-key storage failed:", error);
    notifyKeyStorageFallback();
    usingSessionKeyFallback = true;
    return resolveSessionEncryptionKey(allowSessionFallbackCreation);
  }
}

/**
 * @param {{allowSessionFallbackCreation?: boolean}} [options]
 * @returns {Promise<CryptoKey>}
 */
async function getEncryptionKey(options = {}) {
  const { allowSessionFallbackCreation = true } = options;
  const version = ensureEncryptionKeyVersion();
  if (cachedEncryptionKeyVersion !== version) {
    invalidateEncryptionKeyCache();
  }
  const pending = /** @type {Promise<CryptoKey>} */ (
    encryptionKeyPromise || resolveEncryptionKey(allowSessionFallbackCreation)
  );
  encryptionKeyPromise = pending;
  cachedEncryptionKeyVersion = version;
  try {
    return await pending;
  } catch (error) {
    invalidateEncryptionKeyCache();
    throw error;
  }
}

// Encrypt data using AES-256-GCM
async function encryptData(plaintext) {
  const key = /** @type {CryptoKey} */ (await getEncryptionKey());
  const keyVersion = cachedEncryptionKeyVersion;
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    encoder.encode(plaintext),
  );

  // Combine IV + encrypted data
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return {
    ciphertext: arrayBufferToBase64(combined),
    keyVersion,
    sessionFallback: usingSessionKeyFallback,
  };
}

// Decrypt data using AES-256-GCM
async function decryptData(encryptedBase64, options = {}) {
  const { isSessionCredential = false } = options;
  try {
    const key = /** @type {CryptoKey} */ (await getEncryptionKey({
      allowSessionFallbackCreation: false,
    }));
    if (
      usingSessionKeyFallback
      && !isSessionCredential
      && !sessionFallbackSupportsDurableCredentials
    ) {
      throw new CredentialStorageUnavailableError();
    }
    const combined = base64ToArrayBuffer(encryptedBase64);

    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      key,
      encrypted,
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    if (error instanceof CredentialStorageUnavailableError) throw error;
    console.error("Decryption failed:", error);
    return null;
  }
}

// Helper functions for base64 encoding/decoding
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --- API KEY MANAGEMENT ---

async function saveApiKey(provider, apiKey) {
  if (!apiKey || apiKey.trim() === "") {
    localStorage.removeItem(STORAGE_KEY_PREFIX + provider);
    sessionStorage.removeItem(SESSION_STORAGE_KEY_PREFIX + provider);
    return;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const encrypted = await encryptData(apiKey.trim());
    if (encrypted.keyVersion === currentEncryptionKeyVersion()) {
      const storage = encrypted.sessionFallback ? sessionStorage : localStorage;
      const prefix = encrypted.sessionFallback
        ? SESSION_STORAGE_KEY_PREFIX
        : STORAGE_KEY_PREFIX;
      storage.setItem(prefix + provider, encrypted.ciphertext);
      if (!encrypted.sessionFallback) {
        sessionStorage.removeItem(SESSION_STORAGE_KEY_PREFIX + provider);
      }
      return;
    }
    invalidateEncryptionKeyCache();
  }

  throw new Error("Encryption key changed while saving. Please try again.");
}

async function getApiKey(provider) {
  // Only check user-stored key - no environment fallback
  const sessionEncrypted = sessionStorage.getItem(
    SESSION_STORAGE_KEY_PREFIX + provider,
  );
  const encrypted = sessionEncrypted
    || localStorage.getItem(STORAGE_KEY_PREFIX + provider);
  if (encrypted) {
    let decrypted;
    try {
      decrypted = await decryptData(encrypted, {
        isSessionCredential: Boolean(sessionEncrypted),
      });
    } catch (error) {
      if (error instanceof CredentialStorageUnavailableError) return "";
      throw error;
    }
    if (decrypted) return decrypted;

    // If decryption failed, clean up the stale encrypted data
    const storage = sessionEncrypted ? sessionStorage : localStorage;
    const prefix = sessionEncrypted
      ? SESSION_STORAGE_KEY_PREFIX
      : STORAGE_KEY_PREFIX;
    storage.removeItem(prefix + provider);
  }

  // Return empty string if no user key is configured
  return "";
}

function getFlutterFlowEndpoint() {
  return (
    localStorage.getItem("flutterflow_api_endpoint") ||
    FF_API_ENDPOINTS.production
  );
}

function setFlutterFlowEndpoint(endpoint) {
  localStorage.setItem("flutterflow_api_endpoint", endpoint);
  return true;
}

function hasStoredKey(provider) {
  const keys = {
    flutterflow: flutterflowApiKey,
    flutterflow_project_id: flutterflowProjectId,
  }
  return keys[provider] && keys[provider].length > 0
}

// Get current active API keys (for use in API calls)
let flutterflowApiKey = "";
let flutterflowProjectId = "";

// Per-deploy project override chosen in the confirm modal. When set, the
// commit targets this project instead of the API Keys default, without
// changing the stored configuration.
let commitTargetProjectId = null;

// Guards against a stale in-flight project fetch overwriting the confirm
// modal's dropdown when the modal is closed/reopened before the fetch returns.
let confirmProjectToken = 0;

async function initializeApiKeys() {
  // Remove an exportable key left by an earlier version even if its encrypted
  // credentials were already cleared.
  if (sessionStorage.getItem(ENCRYPTION_KEY_NAME)) {
    await getEncryptionKey();
  }
  flutterflowApiKey = await getApiKey("flutterflow");
  flutterflowProjectId = await getApiKey("flutterflow_project_id");
  updateApiKeyStatusIndicators();
  updateDeployButtonVisibility();
}

// --- API KEY UI FUNCTIONS ---

function openApiKeysModal() {
  const modal = document.getElementById("api-keys-modal");
  openModal(modal);

  // Load current keys into inputs (masked)
  loadApiKeyInputs();

  // The project dropdown is the only way to pick a project, so populate it as
  // soon as a stored key is available.
  if (flutterflowApiKey) {
    fetchProjects(flutterflowApiKey);
  }
}

function closeApiKeysModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById("api-keys-modal");
  if (modal) {
    closeModal(modal);
  }
  // Show walkthrough again after closing API keys
  const walkthroughModal = document.getElementById("walkthrough-modal");
  if (walkthroughModal) {
    advanceWalkthrough();
    openModal(walkthroughModal);
  }
}

let walkthroughStep = 1;

function getWalkthroughSteps() {
  const container = document.querySelector('.wt-steps');
  if (!container) return [];
  return Array.from(container.querySelectorAll('.wt-step-card'));
}

function updateWalkthroughUI() {
  const steps = getWalkthroughSteps();
  if (!steps.length) return;
  steps.forEach((stepEl, idx) => {
    const i = idx + 1;
    if (i === walkthroughStep) {
      stepEl.classList.remove("opacity-60", "bg-gray-50", "border-gray-200");
      stepEl.classList.add("bg-blue-50", "border-blue-200");
      const numEl = stepEl.querySelector("div:first-child");
      if (numEl) {
        numEl.classList.remove("bg-gray-400");
        numEl.classList.add("bg-blue-500");
        numEl.innerHTML = i;
      }
    } else if (i < walkthroughStep) {
      stepEl.classList.remove("opacity-60", "bg-blue-50", "border-blue-200");
      stepEl.classList.add("bg-green-50", "border-green-200");
      const numEl = stepEl.querySelector("div:first-child");
      if (numEl) {
        numEl.classList.remove("bg-blue-500", "bg-gray-400");
        numEl.classList.add("bg-green-500");
        numEl.innerHTML = "✓";
      }
    } else {
      stepEl.classList.add("opacity-60", "bg-gray-50", "border-gray-200");
      stepEl.classList.remove(
        "bg-blue-50",
        "border-blue-200",
        "bg-green-50",
        "border-green-200",
      );
      const numEl = stepEl.querySelector("div:first-child");
      if (numEl) {
        numEl.classList.remove("bg-blue-500", "bg-green-500");
        numEl.classList.add("bg-gray-400");
        numEl.innerHTML = i;
      }
    }
  });
}

function advanceWalkthrough() {
  const totalSteps = getWalkthroughSteps().length;
  if (totalSteps > 0 && walkthroughStep <= totalSteps) {
    walkthroughStep++;
    updateWalkthroughUI();
  }
}

function openWalkthroughModal() {
  const modal = document.getElementById("walkthrough-modal");
  if (modal) {
    walkthroughStep = 1;
    updateWalkthroughUI();
    openModal(modal);
  }
}

function closeWalkthroughModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById("walkthrough-modal");
  if (modal) {
    closeModal(modal);
  }

  const dontShow = document.getElementById("walkthrough-dont-show");
  if (dontShow && dontShow.checked) {
    localStorage.setItem("hasSeenWalkthrough", "true");
  }
}

function showWalkthroughIfNeeded() {
  // Never show walkthrough for paid users
  if (authState.isVerified && isSubscriptionResolved() && subscriptionState.tier !== 'free') return;

  const hasSeen = localStorage.getItem("hasSeenWalkthrough");
  if (!hasSeen) {
    const modal = document.getElementById("walkthrough-modal");
    if (modal) {
      walkthroughStep = 1;
      updateWalkthroughUI();
      openModal(modal);
    }
  }
}

async function loadApiKeyInputs() {
  const flutterflowInput = document.getElementById("flutterflow-api-key-input");

  if (flutterflowApiKey) {
    flutterflowInput.value = "";
    flutterflowInput.placeholder = "Key saved (enter new to replace)";
  } else {
    flutterflowInput.placeholder = "Enter your FlutterFlow API key";
  }

  updateModalKeyStatuses();
}

function updateModalKeyStatuses() {
  updateKeyStatus("flutterflow", "flutterflow-key-status");
  updateKeyStatus("flutterflow_project_id", "flutterflow-project-status");
}

function updateKeyStatus(provider, statusElementId) {
  const statusEl = document.getElementById(statusElementId);
  if (!statusEl) return;

  const dot = statusEl.querySelector(".key-status-dot");
  const text = statusEl.querySelector("span");

  if (hasStoredKey(provider)) {
    dot.className = "key-status-dot configured";
    text.className = "text-green-600";
    text.textContent = "User key configured";
  } else {
    dot.className = "key-status-dot missing";
    text.className = "text-gray-500";
    text.textContent = "Not configured";
  }
}

function updateDeployButtonVisibility() {
  const hasGeneratedCode =
    pipelineState.step2Result && pipelineState.step2Result.length > 0;

  const deployBtn = document.getElementById("btn-deploy-to-ff");

  if (deployBtn) {
    deployBtn.classList.toggle("hidden", !hasGeneratedCode);
  }
}

function updateApiKeyStatusIndicators() {
  const container = document.getElementById("api-keys-status");
  if (!container) return;

  const dots = container.querySelectorAll(".key-status-dot");
  const providers = [
    "flutterflow",
  ];

  dots.forEach((dot, index) => {
    const provider = providers[index];
    if (provider === "flutterflow") {
      // For FlutterFlow, check both API key and Project ID
      if (
        hasStoredKey("flutterflow") &&
        hasStoredKey("flutterflow_project_id")
      ) {
        dot.className = "key-status-dot configured";
        dot.title = "FlutterFlow (Fully configured)";
      } else if (
        hasStoredKey("flutterflow") ||
        hasStoredKey("flutterflow_project_id")
      ) {
        dot.className = "key-status-dot env";
        dot.title = "FlutterFlow (Partially configured)";
      } else {
        dot.className = "key-status-dot missing";
        dot.title = "FlutterFlow (Not configured)";
      }
    } else if (hasStoredKey(provider)) {
      dot.className = "key-status-dot configured";
      dot.title =
        provider.charAt(0).toUpperCase() + provider.slice(1) + " (User key)";
    } else {
      dot.className = "key-status-dot missing";
      dot.title =
        provider.charAt(0).toUpperCase() +
        provider.slice(1) +
        " (Not configured)";
    }
  });

  // Toggle deploy button visibility
  updateDeployButtonVisibility();
}

async function saveApiKeys() {
  const flutterflowInput = document.getElementById("flutterflow-api-key-input");
  const projectSelect = document.getElementById("flutterflow-projects-select");

  // Only save if user entered a new value
  if (flutterflowInput.value.trim()) {
    await saveApiKey("flutterflow", flutterflowInput.value);
  }

  const selectedProjectId = projectSelect?.value.trim() || "";
  if (selectedProjectId) {
    if (!validateFlutterFlowProjectId(selectedProjectId)) {
      showToast("The selected FlutterFlow project has an unexpected ID format.", "error");
      projectSelect.focus();
      return;
    }
    await saveApiKey("flutterflow_project_id", selectedProjectId);
  }

  // Reinitialize keys
  await initializeApiKeys();

  // Update UI
  loadApiKeyInputs();

  // Show confirmation
  const btn = document.querySelector("#api-keys-modal .bg-blue-500");
  const originalText = btn.textContent;
  btn.textContent = "Saved!";
  btn.classList.remove("bg-blue-500", "hover:bg-blue-600");
  btn.classList.add("bg-green-500");

  setTimeout(() => {
    btn.textContent = originalText;
    btn.classList.remove("bg-green-500");
    btn.classList.add("bg-blue-500", "hover:bg-blue-600");
    closeApiKeysModal();
  }, 1000);
}

async function clearAllApiKeys() {
  if (!confirm("Are you sure you want to clear all stored API keys?")) return;

  // Rotate before and after deletion. Other tabs cannot continue treating a
  // cached key as current, and any save that raced with the clear is removed.
  localStorage.setItem(KEY_VERSION_NAME, newEncryptionKeyVersion());
  invalidateEncryptionKeyCache();
  localStorage.removeItem(STORAGE_KEY_PREFIX + "flutterflow");
  localStorage.removeItem(STORAGE_KEY_PREFIX + "flutterflow_project_id");
  sessionStorage.removeItem(SESSION_STORAGE_KEY_PREFIX + "flutterflow");
  sessionStorage.removeItem(SESSION_STORAGE_KEY_PREFIX + "flutterflow_project_id");
  sessionStorage.removeItem(ENCRYPTION_KEY_NAME);
  sessionStorage.removeItem(SESSION_KEY_SCOPE_NAME);
  localStorage.removeItem(STORAGE_KEY_PREFIX + "salt");
  await deleteStoredEncryptionKey();
  localStorage.setItem(KEY_VERSION_NAME, newEncryptionKeyVersion());
  localStorage.removeItem(STORAGE_KEY_PREFIX + "flutterflow");
  localStorage.removeItem(STORAGE_KEY_PREFIX + "flutterflow_project_id");
  sessionStorage.removeItem(SESSION_STORAGE_KEY_PREFIX + "flutterflow");
  sessionStorage.removeItem(SESSION_STORAGE_KEY_PREFIX + "flutterflow_project_id");

  // Reinitialize keys
  await initializeApiKeys();

  const projectSelect = document.getElementById("flutterflow-projects-select");
  if (projectSelect) {
    projectSelect.innerHTML =
      '<option value="">Enter your API key to load projects</option>';
  }

  // Update UI
  loadApiKeyInputs();
}

// --- FLUTTERFLOW CREDENTIAL VALIDATION ---

function validateFlutterFlowApiKey(key) {
  return Boolean(key && key.trim().length > 0);
}

function validateFlutterFlowProjectId(projectId) {
  // FF Project IDs are alphanumeric with dashes, typically format: name-1234-abcd
  if (!projectId || projectId.trim().length < 5) return false;
  if (projectId.includes(" ")) return false;
  return /^[a-zA-Z0-9-]+$/.test(projectId);
}

function updateInputValidationState(inputId, isValid) {
  const input = document.getElementById(inputId);
  if (!input) return;

  if (!input.value) {
    input.style.borderColor = ""; // Reset to default
  } else if (isValid) {
    input.style.borderColor = "#22c55e"; // Green
  } else {
    input.style.borderColor = "#ef4444"; // Red
  }
}

function setupFlutterFlowValidation() {
  const apiKeyInput = document.getElementById("flutterflow-api-key-input");

  if (apiKeyInput) {
    apiKeyInput.addEventListener("input", (e) => {
      const hasValue = e.target.value.trim().length > 0;
      updateInputValidationState("flutterflow-api-key-input", hasValue);
    });
    apiKeyInput.addEventListener(
      "blur",
      debounce(async (e) => {
        const key = e.target.value.trim();
        if (key) {
          await fetchProjects(key);
        }
      }, 500),
    );
  }
}

/**
 * Simple debounce utility.
 * @param {Function} func - Function to debounce
 * @param {number} wait - Milliseconds to wait
 * @returns {Function} Debounced function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Fetches projects from FlutterFlow API and populates the always-visible
 * project dropdown, which is the only way to choose a target project.
 * @param {string} apiKey - FlutterFlow API key
 */
async function fetchProjects(apiKey) {
  const select = document.getElementById("flutterflow-projects-select");
  const errorElement = document.getElementById("flutterflow-projects-error");

  if (!select) {
    console.error("Projects dropdown element not found");
    return;
  }

  // Show loading state
  select.innerHTML = '<option value="">Loading projects...</option>';
  if (errorElement) errorElement.classList.add("hidden");

  try {
    // Create temporary client instance (no project ID needed)
    const client = new FlutterFlowApiClient(apiKey, "");
    const projects = await client.listProjects();

    if (!projects || projects.length === 0) {
      select.innerHTML = '<option value="">No projects found</option>';
      return;
    }

    // Populate dropdown
    select.innerHTML = '<option value="">Select a project...</option>';
    projects.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.id || project.projectId || "";
      option.textContent =
        project.name || project.projectName || `Project ${project.id}`;
      select.appendChild(option);
    });

    // Re-select the already configured project so the dropdown reflects state
    if (flutterflowProjectId) {
      select.value = flutterflowProjectId;
    }
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    select.innerHTML = '<option value="">Error loading projects</option>';
    if (errorElement) {
      errorElement.textContent = `Failed to load projects: ${error.message}`;
      errorElement.classList.remove("hidden");
    }
  }
}

function toggleKeyVisibility(inputId) {
  const input = document.getElementById(inputId);
  const btn = input.nextElementSibling;
  const icon = btn.querySelector("svg");

  if (input.type === "password") {
    input.type = "text";
    icon.innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
    `;
  } else {
    input.type = "password";
    icon.innerHTML = `
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
    `;
  }
}

// --- APP STATE ---
let pipelineState = {
  step1Result: null,
  step2Result: null,
  step3Result: null,
  bundleSpec: null,
  artifactBundle: null,
  bundleReview: null,
  selectedArtifactId: null,
  resultsViewMode: "summary",
  currentStep: 0,
  isRunning: false,
  // Incremented every time a pipeline run starts. Captured locally by each
  // run so a stale run's async step results can never overwrite a newer
  // run's UI state (e.g. a slow first request resolving after the user
  // already retried).
  runId: 0,
  // The prompt and images as submitted, so a retry re-runs exactly what the
  // user sent and an edit returns them to the composer unchanged.
  submittedPrompt: "",
  submittedImages: [],
};

function resetPipelineResults() {
  pipelineState.step1Result = null;
  pipelineState.step2Result = null;
  pipelineState.step3Result = null;
  pipelineState.bundleSpec = null;
  pipelineState.artifactBundle = null;
  pipelineState.bundleReview = null;
  pipelineState.selectedArtifactId = null;
  pipelineState.resultsViewMode = "summary";
}

function updateBundleSpecFromArchitectResult() {
  pipelineState.bundleSpec = normalizeArtifactBundle(pipelineState.step1Result, {
    artifactType: "CustomWidget",
    artifactName: "GeneratedWidget",
  });
}

function updateArtifactBundleFromGeneratedCode() {
  const primarySpecArtifact = getPrimaryArtifact(pipelineState.bundleSpec);
  pipelineState.artifactBundle = normalizeArtifactBundle(pipelineState.step2Result, {
    id: pipelineState.bundleSpec?.id,
    title: pipelineState.bundleSpec?.title,
    description: pipelineState.bundleSpec?.description,
    artifactType: primarySpecArtifact.artifactType,
    artifactName: primarySpecArtifact.artifactName,
    fileName: primarySpecArtifact.fileName,
    dependencies: primarySpecArtifact.dependencies,
    relationships: pipelineState.bundleSpec?.relationships,
    code: pipelineState.step2Result || "",
  });
  const compatibility = validateBundleCompatibility(pipelineState.artifactBundle);
  pipelineState.artifactBundle = {
    ...pipelineState.artifactBundle,
    warnings: [
      ...pipelineState.artifactBundle.warnings,
      ...compatibility.findings.map((finding) => finding.message),
    ],
    metadata: {
      ...pipelineState.artifactBundle.metadata,
      compatibility,
    },
  };
  pipelineState.selectedArtifactId = getPrimaryArtifact(pipelineState.artifactBundle).id;
}

function updateBundleReviewFromReviewResult() {
  const reviewBundle = normalizeArtifactBundle(pipelineState.step3Result, {
    id: pipelineState.artifactBundle?.id,
    title: pipelineState.artifactBundle?.title,
  });
  const reviewByArtifactId = new Map(
    reviewBundle.artifacts.map((artifact) => [artifact.id, artifact.review]),
  );
  const fixedSourceByArtifactId = new Map(
    reviewBundle.artifacts
      .filter((artifact) => {
        const review = artifact.review;
        return review && typeof review.fixedSource === "string" && review.fixedSource.trim();
      })
      .map((artifact) => [artifact.id, artifact.review.fixedSource.trim()]),
  );
  pipelineState.bundleReview = normalizeArtifactBundle({
    id: pipelineState.artifactBundle?.id,
    title: pipelineState.artifactBundle?.title,
    artifacts: pipelineState.artifactBundle?.artifacts?.map((artifact) => {
      const fixedCode = fixedSourceByArtifactId.get(artifact.id) || null;
      return {
        ...artifact,
        review: reviewByArtifactId.get(artifact.id) || artifact.review || pipelineState.step3Result || null,
        ...(fixedCode ? { fixedCode } : {}),
      };
    }) || [],
    relationships: pipelineState.artifactBundle?.relationships,
    warnings: pipelineState.artifactBundle?.warnings,
  });
}

function getCurrentArtifactMetadata() {
  const artifact = getSelectedArtifact();
  return {
    artifactType: artifact.artifactType || "CustomWidget",
    artifactName: artifact.artifactName || "GeneratedWidget",
    // Single-file deploys must name the committed file after the artifact's
    // own validated fileName (FF naively snake_cases the declared class), not
    // a fresh name derived from artifactName. The bundle planner already uses
    // artifact.fileName; the single-file path was dropping it, so FF saw a
    // file named after the artifact name and found no matching widget class.
    fileName: artifact.fileName || "",
  };
}

function getSelectedArtifact() {
  const bundle = pipelineState.artifactBundle || pipelineState.bundleSpec || null;
  const artifacts = Array.isArray(bundle?.artifacts) ? bundle.artifacts : [];
  return artifacts.find((artifact) => artifact.id === pipelineState.selectedArtifactId)
    || getPrimaryArtifact(bundle);
}

function getSelectedArtifactCode() {
  const artifact = getSelectedArtifact();
  return artifact.code || pipelineState.step2Result || "";
}

// --- CORE API FUNCTIONS ---

async function checkConnection() {
  try {
    await initializeApiKeys()
  } catch (error) {
    console.error('checkConnection: initializeApiKeys failed:', error)
    return false
  }
  return true
}

// --- FLUTTERFLOW API CLIENT ---

/**
 * @typedef {Object} FileWarning
 * @property {string} fileType - Type of file (action, widget, function, pubspec)
 * @property {string} errorMessage - Error description
 * @property {boolean} isCritical - If true, prevents syncing
 */

/**
 * @typedef {Object} PushCodeResult
 * @property {number} responseCode - HTTP response code
 * @property {string} [errorMessage] - Error message if failed
 * @property {Map<string, FileWarning[]>} [errorMap] - Map of file paths to warnings
 */

/**
 * FlutterFlow API endpoints
 */
const FF_API_ENDPOINTS = {
  production: "https://api.flutterflow.io/v2/",
  staging: "https://api.flutterflow.io/v2-staging/",
};

/**
 * Builds the actionable error shown when listing projects is denied. Both
 * callers surface this text verbatim in their dropdowns, and re-entering a key
 * in API Keys settings is the app's re-auth path for static FlutterFlow keys.
 * @param {number} status - HTTP status from listProjects
 * @param {string} errorText - Server-provided detail, truncated for display
 * @returns {string} User-facing message naming the fix
 */
function buildListProjectsAuthError(status, errorText) {
  const detail = errorText?.trim()
    ? ` (${errorText.trim().slice(0, 200)})`
    : "";
  if (status === 401) {
    return `Your FlutterFlow API key was rejected (401 Unauthorized)${detail}. Re-enter a current key under API Keys settings, then try again.`;
  }
  return `Listing FlutterFlow projects was denied (403)${detail}. The key may be scoped to sync a single project without list permission - verify the key's access in FlutterFlow, re-enter it under API Keys settings, then retry.`;
}

/**
 * Client for interacting with the FlutterFlow API.
 * Adapted from the VS Code extension for browser use.
 * Handles authentication and provides methods for code synchronization.
 */
class FlutterFlowApiClient {
  /**
   * Creates a new FlutterFlow API client instance.
   * @param {string} apiKey - Authentication token for API access
   * @param {string} projectId - ID of the FlutterFlow project
   * @param {string} [branchName='main'] - Name of the branch to work with
   * @param {string} [endpoint='production'] - API endpoint to use
   */
  constructor(
    apiKey,
    projectId,
    branchName = "main",
    endpoint = FF_API_ENDPOINTS.production,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = endpoint;
    this._projectId = projectId;
    this._branchName = branchName;
    this._endpoint = endpoint;
  }

  /**
   * Gets the project ID.
   * @returns {string} The FlutterFlow project ID
   */
  get projectId() {
    return this._projectId;
  }

  /**
   * Gets the branch name.
   * In FlutterFlow, "main" and "" both represent the default branch.
   * @returns {string} The branch name (empty string for main branch)
   */
  get branchName() {
    // "main" and "" both represent the default branch in FlutterFlow. The APIs expect "".
    return this._branchName === "main" ? "" : this._branchName;
  }

  /**
   * Exports the project source and returns the base64 zip, mirroring the
   * VS Code extension's exportCode call.
   * @returns {Promise<string>} Base64-encoded project zip
   */
  async exportProjectZip() {
    console.log(
      `Exporting code from FlutterFlow project: ${this.projectId}, branch: ${this.branchName || "main"}`,
    );

    // The extension's request shape is tried first; the flat shape is kept as a
    // fallback for API deployments that still expect it.
    const requestBodies = [
      {
        project: { path: `projects/${this.projectId}` },
        ...(this.branchName ? { branch_name: this.branchName } : {}),
        export_as_module: false,
        include_assets_map: false,
        format: false,
        export_as_debug: false,
      },
      {
        project_id: this.projectId,
        branch_name: this.branchName,
        include_assets: false,
        export_as_module: false,
      },
    ];

    let lastError = null;
    for (const body of requestBodies) {
      try {
        const response = await fetch(`${this.baseUrl}exportCode`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorText = await response.text();
          lastError = new Error(
            `Export failed: ${response.status} - ${errorText}`,
          );
          continue;
        }

        const data = await response.json();
        const projectZip = data?.value?.project_zip || data?.project_zip;
        if (!projectZip) {
          lastError = new Error(
            "Export response did not include project source.",
          );
          continue;
        }
        return projectZip;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Export failed for an unknown reason.");
  }

  /**
   * Reads the project's current pubspec.yaml and custom-code source files out
   * of one export.
   * @returns {Promise<{pubspecYaml: string, files: Map<string, string>}>}
   */
  async fetchProjectSource() {
    const base64Zip = await this.exportProjectZip();
    const zip = await JSZip.loadAsync(base64Zip, { base64: true });

    // Exports are nested under a single project folder. Pick the shallowest
    // pubspec.yaml so a bundled sub-package's manifest can't be mistaken for
    // the project's own.
    const pubspecPath = Object.keys(zip.files)
      .filter(
        (path) =>
          !zip.files[path].dir &&
          (path === "pubspec.yaml" || path.endsWith("/pubspec.yaml")),
      )
      .sort((a, b) => a.split("/").length - b.split("/").length)[0];

    if (!pubspecPath) {
      throw new Error("Export did not contain a pubspec.yaml.");
    }

    const rootPrefix = pubspecPath.slice(
      0,
      pubspecPath.length - "pubspec.yaml".length,
    );
    const files = new Map();
    const sourcePaths = Object.keys(zip.files).filter((archivePath) => {
      if (zip.files[archivePath].dir || !archivePath.startsWith(rootPrefix)) {
        return false;
      }
      const projectPath = archivePath.slice(rootPrefix.length);
      return (
        projectPath === "lib/flutter_flow/custom_functions.dart" ||
        (projectPath.startsWith("lib/custom_code/") &&
          projectPath.endsWith(".dart"))
      );
    });

    await Promise.all(
      sourcePaths.map(async (archivePath) => {
        files.set(
          archivePath.slice(rootPrefix.length),
          await zip.files[archivePath].async("string"),
        );
      }),
    );

    return {
      pubspecYaml: await zip.files[pubspecPath].async("string"),
      files,
    };
  }

  /**
   * Pushes custom code to FlutterFlow.
   * @param {Object} pushCodeRequest - Request object containing code data
   * @param {string} pushCodeRequest.project_id - FlutterFlow project ID
   * @param {string} pushCodeRequest.zipped_custom_code - Base64 encoded zip of custom code
   * @param {string} pushCodeRequest.uid - User identifier
   * @param {string} pushCodeRequest.branch_name - Target branch name
   * @param {string} pushCodeRequest.serialized_yaml - Serialized pubspec.yaml content
   * @param {string} pushCodeRequest.file_map - JSON string of file path to content mapping
   * @param {string} pushCodeRequest.functions_map - JSON string of function definitions
   * @returns {Promise<Response>} Fetch response object
   */
  async pushCodeWithRetry(pushCodeRequest, maxRetries = 3) {
    const endpointUrls = [
      FF_API_ENDPOINTS.production,
      FF_API_ENDPOINTS.staging,
    ];
    const startEndpoint = Math.max(0, endpointUrls.indexOf(this._endpoint));

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      for (let ei = startEndpoint; ei < endpointUrls.length; ei++) {
        const baseUrl = endpointUrls[ei];

        try {
          console.log(
            `Push attempt ${attempt + 1} to ${baseUrl}syncCustomCodeChanges`,
          );
          console.log("Request metadata:", {
            project_id: pushCodeRequest.project_id,
            branch_name: pushCodeRequest.branch_name,
            uid: pushCodeRequest.uid,
            zipped_custom_code_length:
              pushCodeRequest.zipped_custom_code?.length || 0,
            file_map_length: pushCodeRequest.file_map?.length || 0,
            functions_map_length: pushCodeRequest.functions_map?.length || 0,
          });
          const response = await fetch(`${baseUrl}syncCustomCodeChanges`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(pushCodeRequest),
          });

          if (response.ok) {
            console.log(`Push to ${baseUrl} succeeded!`);
            return response;
          }

          const clonedForLog = response.clone();
          const responseText = await clonedForLog.text();
          console.log(
            `Push to ${baseUrl} returned ${response.status}: ${responseText}`,
          );

          if (response.status === 500) {
            console.warn(`Endpoint ${baseUrl} returned 500, trying next...`);
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }

          return response;
        } catch (error) {
          console.warn(
            `Push to ${baseUrl} failed: ${error.message}, trying next...`,
          );
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    throw new Error("All API endpoints failed after retries");
  }

  async pushCode(pushCodeRequest) {
    return this.pushCodeWithRetry(pushCodeRequest);
  }

  /**
   * Parses a successful listProjects payload. Handles FlutterFlow's wrapper
   * format ({ success: true, value: "<stringified json>" }) plus looser
   * shapes older deployments return.
   * @param {Object} data - Parsed JSON body
   * @returns {Array<Object>} Projects as { id, name }
   */
  parseProjectsResponse(data) {
    if (data?.success && typeof data.value === "string") {
      try {
        const parsedValue = JSON.parse(data.value);
        if (parsedValue && Array.isArray(parsedValue.entries)) {
          return parsedValue.entries.map((entry) => ({
            id: entry.id,
            name: entry.project?.name || entry.id,
          }));
        }
      } catch (parseError) {
        console.error("Failed to parse stringified project value:", parseError);
      }
    }

    const projects =
      data?.projects || data?.items || data?.entries
      || (Array.isArray(data) ? data : []);
    return Array.isArray(projects) ? projects : [];
  }

  async listProjects() {
    console.log("Listing projects for API key");

    // Every other call in this client targets `${baseUrl}<method>`; this one
    // alone hardcoded a legacy `/v2/l/` path that the gateway rejects with
    // 401/403 before the key is evaluated, surfacing as "List projects failed:
    // 403 Unauthorized" while sync calls with the same key worked. The
    // convention path goes first; the legacy path is retried once on 404 only,
    // so an auth rejection is never masked by a retry.
    const attemptUrls = [
      `${this.baseUrl}listProjects`,
      "https://api.flutterflow.io/v2/l/listProjects",
    ];
    let lastStatus = 0;
    let lastErrorText = "";

    for (const url of attemptUrls) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          project_type: "ALL",
          deserialize_response: true,
        }),
      });

      if (response.ok) {
        if (url !== attemptUrls[0]) {
          console.log(`listProjects answered on legacy path ${url}`);
        }
        return this.parseProjectsResponse(await response.json());
      }

      lastStatus = response.status;
      lastErrorText = await response.text();
      console.warn(
        `listProjects via ${url} returned ${lastStatus}: ${lastErrorText}`,
      );

      // 401 means the key itself is invalid/expired; 403 usually means the key
      // is valid but scoped to sync a single project without list permission.
      // Either way the user must act in API Keys settings, so fail with that
      // instruction instead of a raw status line.
      if (response.status === 401 || response.status === 403) {
        throw new Error(buildListProjectsAuthError(response.status, lastErrorText));
      }
      if (response.status !== 404) {
        throw new Error(`List projects failed: ${response.status} - ${lastErrorText}`);
      }
    }

    throw new Error(`List projects failed: ${lastStatus} - ${lastErrorText}`);
  }
}

/**
 * Parses the response from pushCode API call.
 * @param {Response} response - Fetch response object
 * @returns {Promise<Object>} Parsed result with file warnings
 */
async function parsePushCodeResponse(response) {
  const originalResponse = response.clone();
  let jsonResult;

  try {
    jsonResult = await response.json();
  } catch (error) {
    const text = await originalResponse.text();

    // Check if the response was an error with plain text body (common for 500s)
    if (!response.ok) {
      return {
        success: false,
        responseCode: response.status,
        errorMessage: text || `HTTP ${response.status}`,
        errorMap: new Map(),
      };
    }

    throw new Error(`Invalid JSON response: ${text}`);
  }

  if (!response.ok) {
    // FlutterFlow 400s return file-keyed error maps: {"File.dart": [{"errorMessage": "...", "isCritical": true}]}
    // Standard errors return: {"message": "..."}
    let errorMessage = jsonResult.message || `HTTP ${response.status}`
    let errorMap = new Map()

    if (jsonResult.errors) {
      errorMap = new Map(Object.entries(jsonResult.errors))
    } else if (!jsonResult.message && typeof jsonResult === 'object') {
      // Detect file-keyed error format (keys ending in .dart with array values)
      const fileKeys = Object.keys(jsonResult).filter(k => k.endsWith('.dart') && Array.isArray(jsonResult[k]))
      if (fileKeys.length > 0) {
        errorMap = new Map(Object.entries(jsonResult))
        const allErrors = fileKeys.flatMap(k => jsonResult[k].map(e => `${k}: ${e.errorMessage}`))
        errorMessage = allErrors.join('\n') || `HTTP ${response.status}`
      }
    }

    return {
      success: false,
      responseCode: response.status,
      errorMessage,
      errorMap,
    };
  }

  // Success response. The value payload carries per-file warnings; a malformed
  // or non-string value must not fail the whole commit - the push itself
  // already succeeded (HTTP ok), so degrade to "no warnings" instead.
  let valueObject = {};
  if (jsonResult.value) {
    try {
      valueObject =
        typeof jsonResult.value === "string"
          ? JSON.parse(jsonResult.value)
          : jsonResult.value;
    } catch (parseError) {
      console.warn("Ignoring malformed push response value:", parseError);
    }
  }
  return {
    success: true,
    responseCode: response.status,
    errorMap: new Map(Object.entries(valueObject)),
  };
}

/**
 * Gets user-friendly error message for FlutterFlow API errors.
 * @param {number} statusCode - HTTP status code
 * @param {string} [message] - Optional error message from API
 * @returns {string} User-friendly error message
 */
function getFlutterFlowErrorMessage(statusCode, message) {
  const errorMessages = {
    401: "Authentication failed. Please check your FlutterFlow API key.",
    403: "Access denied. You may not have permission to modify this project.",
    404: "Project not found. Please check your Project ID.",
    409: "Conflict detected. The project may have been modified elsewhere.",
    422: `Validation failed: ${message || "Invalid request format"}`,
    429: "Rate limit exceeded. Please try again in a few minutes.",
    500: "FlutterFlow server error. Please try again later.",
    503: "FlutterFlow service temporarily unavailable.",
  };

  return (
    errorMessages[statusCode] ||
    `FlutterFlow API error: ${message || `HTTP ${statusCode}`}`
  );
}

// --- FILE TYPE DETECTION UTILITIES ---

/**
 * Code type enumeration for FlutterFlow custom code
 * @typedef {Object} CodeType
 * @property {string} ACTION - Custom Action ('A')
 * @property {string} WIDGET - Custom Widget ('W')
 * @property {string} FUNCTION - Custom Function ('F')
 * @property {string} DEPENDENCIES - pubspec.yaml dependencies ('D')
 * @property {string} OTHER - Other file types ('O')
 */
const CodeType = {
  ACTION: "A",
  WIDGET: "W",
  FUNCTION: "F",
  // Standalone custom code file under lib/custom_code/, e.g. a plain Dart
  // class. FlutterFlow syncs these through syncCustomCodeChanges like any
  // other custom code file.
  CODE_FILE: "C",
  DEPENDENCIES: "D",
  OTHER: "O",
};

const WIDGET_CLASS_REGEX =
  /class\s+\w+\s+extends\s+(?:StatelessWidget|StatefulWidget)\b/;
const STATE_CLASS_REGEX = /extends\s+State<\w+>/;

/**
 * Detects the type of custom code based on file name and content.
 * @param {string} fileName - Name of the file
 * @param {string} [content] - Optional file content for additional detection
 * @returns {string} Code type (A, W, F, C, D, or O)
 */
function detectCodeType(fileName, content = "") {
  if (fileName === "pubspec.yaml") {
    return CodeType.DEPENDENCIES;
  }

  if (!fileName.endsWith(".dart") || fileName.endsWith("index.dart")) {
    return CodeType.OTHER;
  }

  if (fileName === "custom_functions.dart") {
    return CodeType.FUNCTION;
  }

  if (content) {
    const hasWidgetClass = WIDGET_CLASS_REGEX.test(content);
    const hasStateClass = STATE_CLASS_REGEX.test(content);

    if (hasWidgetClass || hasStateClass) {
      return CodeType.WIDGET;
    }

    if (/^\s*Future(?:<[^>]+>)?\s+\w+\s*\(/m.test(content)) {
      return CodeType.ACTION;
    }

    if (
      content.match(
        /^\s*(String|int|double|bool|List|Map|dynamic|void)\s+\w+\s*\(/m,
      )
    ) {
      return CodeType.FUNCTION;
    }
  }

  // Anything else that is still Dart — a plain class, an enum, a mixin, a
  // utility library — is a standalone custom code file.
  return CodeType.CODE_FILE;
}

/**
 * Gets the relative file path based on code type.
 * @param {string} fileName - Original file name
 * @param {string} codeType - Code type (A, W, F, C, D, O)
 * @returns {string} Relative path in FlutterFlow structure
 */
function getFilePathForCodeType(fileName, codeType) {
  switch (codeType) {
    case CodeType.ACTION:
      return `lib/custom_code/actions/${fileName}`;
    case CodeType.WIDGET:
      return `lib/custom_code/widgets/${fileName}`;
    case CodeType.FUNCTION:
      return "lib/flutter_flow/custom_functions.dart";
    case CodeType.CODE_FILE:
      // Standalone custom code files are flat under lib/custom_code/.
      return `lib/custom_code/${fileName}`;
    case CodeType.DEPENDENCIES:
      return "pubspec.yaml";
    case CodeType.OTHER:
      return `lib/custom_code/${fileName}`;
    default:
      return fileName;
  }
}

/**
 * Builds the file_map in the format expected by FlutterFlow's syncCustomCodeChanges API.
 * New files carry current_checksum without original_checksum; existing files
 * carry both, matching FlutterFlow's VS Code extension.
 * @param {Map} fileMap - Internal file map with content/type/path
 * @param {Map<string, string>} remoteFiles - Current project source by path
 * @returns {Promise<{fileMapContents: string, functionsMapContents: string}>}
 */
async function buildApiSyncMetadata(fileMap, remoteFiles = new Map()) {
  return buildFlutterFlowSyncMetadata(fileMap, remoteFiles);
}

/**
 * Checks if a file is new (has no original checksum).
 * @param {Object} fileInfo - File information object
 * @param {string} [fileInfo.original_checksum] - Original checksum of the file
 * @returns {boolean} True if the file is new
 */
function isNewFile(fileInfo) {
  return fileInfo.original_checksum === undefined;
}

/**
 * Extracts the file name from a full path.
 * @param {string} filePath - Full file path
 * @returns {string} File name without path
 */
function getFileNameFromPath(filePath) {
  return filePath.split("/").pop();
}

// --- PUBSPEC.YAML UTILITIES ---

// The project's current pubspec and custom-code files, cached per project for
// the session. Fetching them means one full project export.
const projectSourceCache = new Map();

function projectSourceCacheKey(apiClient) {
  return `${apiClient.baseUrl}|${apiClient.projectId}|${apiClient.branchName}`;
}

function invalidateProjectSourceCache(apiClient) {
  projectSourceCache.delete(projectSourceCacheKey(apiClient));
}

/**
 * A carve-out from the ordinary failure path: the client stopped waiting for
 * (or lost the connection to) the deployment runner before it reported a
 * decision, so the remote outcome is unknown. This is deliberately *not* a
 * plain failure — nothing here may be reported as failed or committed when we
 * cannot know what the server did.
 */
class UnconfirmedDeployError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnconfirmedDeployError";
    this.outcome = DeployOutcome.UNCONFIRMED;
  }
}

/**
 * Bounded waiting for a remote write. The UI shows live progress only while
 * this promise settles; once the bound expires the waiter stops claiming
 * progress and `onExpire` decides the terminal outcome. The underlying promise
 * is deliberately *not* aborted or retried: it is handed back to the pending
 * work, and any late settlement is ignored (the bound already resolved the
 * waiter). This is a rendering bound, never a transport one.
 * @param {Promise} promise - Work whose remote outcome may or may not arrive
 * @param {number} ms - How long to wait for a decision
 * @param {function} onExpire - Called with (resolve, reject) exactly once on expiry
 * @returns {Promise} Settles with the work's value, or via onExpire on timeout
 */
function withUiTimeout(promise, ms, onExpire) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value, which) => {
      if (settled) return;
      settled = true;
      if (which === "resolve") resolve(value);
      else reject(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onExpire(resolve, reject);
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); finish(resolve, value, "resolve"); },
      (error) => { clearTimeout(timer); finish(reject, error, "reject"); },
    );
  });
}

async function provisionMissingCodeFiles(
  apiClient,
  fileMap,
  remoteFiles,
  commitMessage,
  pubspecYaml = "",
) {
  const missingCodeFiles = findMissingCodeFiles(fileMap, remoteFiles);
  if (missingCodeFiles.length === 0) {
    return { remoteFiles, syncFileMap: fileMap, unverified: [], approximate: [] };
  }

  // The runner compiles these against the project's own package versions
  // before it writes anything, so an API the generated code invented - a named
  // argument the package never declared - stops the deploy instead of landing
  // in the project and breaking every widget that imports the class.
  const verificationPlan = planCustomCodeVerification(
    missingCodeFiles,
    pubspecYaml,
  );
  // Names and constraints, not pubspec.yaml text: the runner builds the
  // manifest itself, so a caller cannot point `pub get` at a git or path source.
  const verification = {
    ...verificationPlan.manifest,
    sources: verificationPlan.sources,
  };

  // Say plainly what is about to be pushed without being compiled first, and
  // say it before the push: a class the runner cannot build in isolation still
  // deploys, but the warning has to precede the mutation it describes.
  const unverified = verificationPlan.skipped.map((entry) => entry.reason);
  unverified.forEach((reason) => console.warn(`[custom class deploy] ${reason}`));

  // Classes that do not import an unrepresentable package directly are still
  // checked, but against a scratch graph that omits it. That approximation is
  // disclosed here - before the push - and returned alongside `unverified`,
  // so it reaches the deploy result and is never mistaken for a full-graph
  // check.
  const approximate = verificationPlan.approximate;
  approximate.forEach((notice) => console.warn(`[custom class deploy] ${notice}`));

  console.log(
    `Provisioning ${missingCodeFiles.length} new FlutterFlow custom code file(s) before sync.`,
  );
  commitProgress.set("provision");
  const response = await fetch(FLUTTERFLOW_CLASS_PROVISION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: apiClient.apiKey,
      projectId: apiClient.projectId,
      baseUrl: apiClient.baseUrl,
      commitMessage,
      customClasses: missingCodeFiles,
      verification,
      stream: true,
    }),
  });

  const result = await withUiTimeout(
    readProvisionResponse(response, {
      onPhase: (message) => commitProgress.setSubstatus(message),
      onLog: (message) => console.log(`[custom class deploy] ${message}`),
    }),
    DEPLOY_UI_TIMEOUT_MS,
    (resolve, reject) =>
      reject(
        new UnconfirmedDeployError(
          "The deploy is still working on the FlutterFlow server, but this browser tab has stopped waiting. " +
            "Your custom classes may or may not have been written — the outcome is not yet known. " +
            "Open your FlutterFlow project to reconcile before retrying the deploy.",
        ),
      ),
  );

  // A stream that ended (or a body that carried) no definitive result leaves
  // the remote decision ambiguous. There are two distinct cases which must not
  // be flattened: a server that explicitly refused the request (a 403/5xx
  // `response.ok === false`) has made a definitive decision — the write did not
  // happen — so that is a FAILURE, not an unknown outcome; only an ok response
  // whose stream dropped before a result (or a client wait expiry) leaves the
  // remote state genuinely unknown and must be reported UNCONFIRMED.
  if (!result.finalResultReceived) {
    if (deployOutcomeOfStreamResult(result) === DeployOutcome.FAILED) {
      throw new Error(
        result.error ||
          `FlutterFlow custom class provisioning failed (HTTP ${result.httpStatus}).`,
      );
    }
    throw new UnconfirmedDeployError(
      "The connection to the FlutterFlow deploy runner dropped before it reported a result. " +
        "The deploy may still be finishing on the server; open your FlutterFlow project to reconcile " +
        "before retrying.",
    );
  }

  if (!result.success) {
    const details = result.details ? ` ${result.details}` : "";
    throw new Error(
      `${result.error || "FlutterFlow custom class provisioning failed."}${details}`,
    );
  }

  invalidateProjectSourceCache(apiClient);

  if (result.verificationSkipped) {
    console.warn(`[custom class deploy] ${result.verificationSkipped}`);
    unverified.push(result.verificationSkipped);
  }

  return {
    remoteFiles,
    syncFileMap: excludeProvisionedCodeFiles(fileMap, missingCodeFiles),
    unverified,
    approximate,
    // Custom classes were actually upserted on the FlutterFlow side by the
    // runner. Any failure of the *remaining* sync is therefore a partial
    // outcome — classes wrote, the rest did not — never a clean total failure.
    provisionSucceeded: true,
  };
}

/**
 * Reads the project's current pubspec.yaml, then merges in the packages the
 * generated code needs at versions the project can actually build.
 *
 * FlutterFlow applies the pushed `serialized_yaml` as the project's complete
 * dependency set, so this must start from the file already in the project.
 * Synthesizing one would silently drop every package the project already had.
 *
 * A package the project already declares keeps its version. One it does not
 * gets the newest pub.dev release compatible with the SDK floor the project's
 * own `environment:` block declares.
 *
 * @param {FlutterFlowApiClient} apiClient - Client for the target project
 * @param {Object<string, string>} newDependencies - name -> the minimum
 *   version the generated code requires, or "" when it needs no specific one
 * @returns {Promise<{
 *   yaml: string,
 *   added: string[],
 *   alreadyPresent: string[],
 *   overridden: Array<{name: string, from: string, to: string}>,
 *   warnings: string[],
 *   remoteFiles: Map<string, string>,
 * }>}
 * @throws If the project's pubspec.yaml cannot be read, so a deploy fails
 *   rather than overwriting the project's dependencies with a guess.
 */
async function resolveProjectPubspec(apiClient, newDependencies = {}) {
  const cacheKey = projectSourceCacheKey(apiClient);

  let projectSource = projectSourceCache.get(cacheKey);
  if (projectSource === undefined) {
    try {
      projectSource = await apiClient.fetchProjectSource();
    } catch (error) {
      throw new Error(
        `Could not read your project's pubspec.yaml (${error.message}). ` +
          "Deploy was stopped so your existing package dependencies aren't overwritten. " +
          "Check your FlutterFlow API key and project, then try again.",
      );
    }

    const validation = validateProjectPubspec(projectSource.pubspecYaml);
    if (!validation.valid) {
      throw new Error(
        `Your project's pubspec.yaml could not be read reliably (${validation.errors.join("; ")}). ` +
          "Deploy was stopped so your existing package dependencies aren't overwritten.",
      );
    }

    projectSourceCache.set(cacheKey, projectSource);
  }

  const plan = await planDependencyChanges(
    projectSource.pubspecYaml,
    newDependencies,
  );
  const overrides = applyDependencyOverrides(
    projectSource.pubspecYaml,
    plan.overrides,
  );
  const merged = mergeDependenciesIntoYaml(overrides.yaml, plan.additions);

  plan.warnings.forEach((warning) => console.warn(`[pubspec] ${warning}`));
  if (merged.added.length > 0) {
    console.log(
      "Adding dependencies:",
      merged.added.map((name) => `${name}: ${plan.additions[name] || "any"}`).join(", "),
      plan.sdk.dartSdkFloor ? `(resolved for Dart ${plan.sdk.dartSdkFloor})` : "",
    );
  }
  plan.kept.forEach(({ name, constraint }) =>
    console.log(`Keeping your existing ${name}: ${constraint || "(non-version source)"}`),
  );

  return {
    ...merged,
    overridden: overrides.overridden,
    warnings: plan.warnings,
    remoteFiles: projectSource.files,
  };
}

/**
 * Runs pre-commit validation checks.
 * @param {Object} codeInfo - Prepared code info
 * @returns {Object} Check results { canProceed: boolean, issues: string[], warnings: string[] }
 */
function runPreCommitChecks(codeInfo) {
  const issues = [];
  const warnings = [];

  if (codeInfo.content.length > 50000) {
    warnings.push(
      "Code file is large (>50KB). This may take longer to commit.",
    );
  }
  if (codeInfo.content.length > 100000) {
    issues.push(
      "Code file is too large (>100KB). Consider splitting into smaller components.",
    );
  }

  const lineCount = codeInfo.content.split("\n").length;
  if (lineCount > 500) {
    warnings.push(
      `Code has ${lineCount} lines. Consider breaking it into smaller widgets.`,
    );
  }

  if (
    codeInfo.content.includes("setState") &&
    codeInfo.codeType === CodeType.ACTION
  ) {
    warnings.push(
      "Using setState in a Custom Action may not work as expected. Consider using a Custom Widget.",
    );
  }

  if (codeInfo.content.includes("dynamic") && !codeInfo.content.includes("?")) {
    warnings.push(
      'Code uses "dynamic" types. Consider adding explicit types for better null safety.',
    );
  }

  if (codeInfo.content.match(/Color\(0xFF[0-9A-Fa-f]{6}\)/)) {
    warnings.push(
      "Code contains hardcoded colors. Consider using FlutterFlowTheme.of(context) for theme consistency.",
    );
  }

  const printMatches = codeInfo.content.match(/print\s*\(/g);
  if (printMatches && printMatches.length > 3) {
    warnings.push(
      `Code contains ${printMatches.length} print statements. Consider removing debug prints before committing.`,
    );
  }

  // FlutterFlow formats every pushed file with dart_style, which fails on
  // unbalanced brackets with the opaque "Custom widget code is not
  // formattable". Catch it here, where the message can say exactly what and
  // where is wrong, instead of after a round-trip to FF.
  const unbalancedBrackets = findUnbalancedBracketError(codeInfo.content);
  if (unbalancedBrackets) {
    issues.push(
      `FlutterFlow cannot format this code - ${unbalancedBrackets}. Fix or regenerate before committing.`,
    );
  }

  // A CustomWidget is committed under a file name FlutterFlow reads the widget
  // identity back out of. If the code declares no public widget class, or the
  // declared class cannot be recovered from the file name, FlutterFlow rejects
  // the push with "Custom widget code is not formattable" / "No widget <name>
  // found". Catch that here instead of after a round-trip to FF.
  if (codeInfo.codeType === CodeType.WIDGET) {
    const declared = getDeclaredWidgetClasses(codeInfo.content);
    const expectedFromFile = expectedWidgetClassFromFileName(codeInfo.fileName);
    if (declared.length === 0) {
      issues.push(
        "No public widget class found (must extend StatelessWidget or StatefulWidget).",
      );
    } else if (!declared.includes(expectedFromFile)) {
      const expected = `${widgetFileNameForClass(declared[0])}`;
      issues.push(
        `Widget class name "${declared[0]}" does not match the file name "${codeInfo.fileName}". FlutterFlow derives the widget from the file name, so it will report "No widget ${expectedFromFile} found". Rename the file to "${expected}" or the class to match before committing.`,
      );
    }
  }

  return {
    canProceed: issues.length === 0,
    issues,
    warnings,
  };
}

// --- FILE VALIDATION FUNCTIONS ---

/**
 * Prepares generated code for FlutterFlow commit.
 * @param {string} rawCode - Raw generated Dart code
 * @param {Object} options - Preparation options
 * @param {string} options.artifactType - Type of artifact (CustomWidget, CustomAction, CustomFunction)
 * @param {string} options.artifactName - Name of the artifact class/function
 * @returns {Object} Prepared code info { content: string, fileName: string, codeType: string }
 */
function prepareCodeForCommit(rawCode, options = {}) {
  const {
    artifactType = "CustomWidget",
    artifactName = "GeneratedCode",
    fileName: providedFileName,
  } = options;

  // Strip BOM, markdown code fences, and blank padding. LLM responses arrive
  // wrapped in fences often enough that leaving them in guarantees FlutterFlow
  // rejects the push as "not formattable".
  const cleanedCode = sanitizeGeneratedDart(rawCode);

  // FF derives a widget's identity from the committed file name, so a widget
  // must land under the FF naive snake_case of the class the code actually
  // declares - not under the artifact's display name ("Liquid Glass Orbs"
  // becomes a file FF cannot resolve to any widget). Any other name - even one
  // that merely capitalizes differently - makes FF report "No widget <name>
  // found", so a declared class always wins and the file is renamed (and
  // logged) to match. CustomFunction always lands in custom_functions.dart.
  let fileName = providedFileName || artifactName;
  if (artifactType === "CustomFunction") {
    fileName = "custom_functions.dart";
  } else if (artifactType === "CustomWidget") {
    const declaredClass = getDeclaredWidgetClasses(cleanedCode)[0];
    const canonicalName = declaredClass
      ? widgetFileNameForClass(declaredClass)
      : null;
    if (canonicalName && fileName !== canonicalName) {
      console.warn(
        `Commit file name "${fileName}" does not match declared widget class "${declaredClass}"; renaming to "${canonicalName}" so FlutterFlow can find the widget.`,
      );
      fileName = canonicalName;
    } else if (!fileName.endsWith(".dart")) {
      fileName += ".dart";
    }
  } else if (!fileName.endsWith(".dart")) {
    fileName += ".dart";
  }

  // Determine code type from artifact type
  let codeType = CodeType.CODE_FILE;
  switch (artifactType) {
    case "CustomAction":
      codeType = CodeType.ACTION;
      break;
    case "CustomWidget":
      codeType = CodeType.WIDGET;
      break;
    case "CustomFunction":
      codeType = CodeType.FUNCTION;
      break;
    case "CustomClass":
    case "CodeFile":
      // Standalone custom code files, synced to lib/custom_code/ as type "C".
      codeType = CodeType.CODE_FILE;
      break;
  }

  // Add mandatory FlutterFlow header (matching VS-Code-Extension pattern)
  let header = "";
  if (codeType === CodeType.WIDGET) {
    header = `// Automatic FlutterFlow imports
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import 'package:flutter/material.dart';
// Begin custom widget code
// DO NOT REMOVE OR MODIFY THE CODE ABOVE!

`;
  } else if (codeType === CodeType.ACTION) {
    header = `// Automatic FlutterFlow imports
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import 'package:flutter/material.dart';
// Begin custom action code
// DO NOT REMOVE OR MODIFY THE CODE ABOVE!

`;
  } else if (codeType === CodeType.FUNCTION) {
    header = `// Automatic FlutterFlow imports
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import 'package:timeago/timeago.dart' as timeago;
import '/flutter_flow/lat_lng.dart';
import '/flutter_flow/place.dart';
import '/flutter_flow/uploaded_file.dart';

`;
  }

  return {
    content: applyFlutterFlowHeader(cleanedCode, header),
    fileName,
    codeType,
    artifactType,
    artifactName,
  };
}

/**
 * Extracts the packages generated code imports.
 *
 * Each is left without a version: the deploy resolves one against the
 * project's own pubspec and SDK floor rather than guessing here.
 *
 * @param {string} code - Dart code to analyze
 * @returns {Object} Map of package names to required minimum versions
 */
function extractDependencies(code) {
  const deps = {};
  for (const name of extractPackageImports(code)) {
    deps[name] = "";
  }
  return deps;
}

/**
 * Builds metadata for the commit operation.
 * @param {Object} codeInfo - Code info from prepareCodeForCommit
 * @param {Object} pipelineResult - Results from the generation pipeline (optional)
 * @returns {Object} Commit metadata
 */
function buildCommitMetadata(codeInfo, pipelineResult = {}) {
  return {
    timestamp: new Date().toISOString(),
    artifactType: codeInfo.artifactType,
    artifactName: codeInfo.artifactName,
    codeType: codeInfo.codeType,
    fileName: codeInfo.fileName,
    generatedFrom: pipelineResult.step1Result ? "pipeline" : "direct",
    model: pipelineResult.selectedModel || "unknown",
    codeSize: codeInfo.content.length,
  };
}

/**
 * Validates a Dart file for FlutterFlow compatibility.
 * @param {string} fileName - Name of the file
 * @param {string} content - File content
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
function validateDartFile(
  fileName,
  content,
  codeType,
  declaredTypes = new Set(),
  artifactName = "",
) {
  const errors = [];
  const hasWidgetClass = WIDGET_CLASS_REGEX.test(content);
  const hasStateClass = STATE_CLASS_REGEX.test(content);

  // Forbidden patterns (main, runApp, MaterialApp, Scaffold) and import
  // validation live in the REVIEW_SYSTEM prompt on BuildShip so a stale
  // client cannot bypass them.

  // Check for required patterns in widgets
  if (codeType === CodeType.WIDGET && !hasWidgetClass && !hasStateClass) {
    errors.push(
      "No widget class definition found (must extend StatelessWidget or StatefulWidget)",
    );
  }

  // Widget construction (required/non-nullable params), Action
  // return-type / file-name checks, forbidden patterns (main, runApp,
  // MaterialApp, Scaffold), and import validation all live in the
  // REVIEW_SYSTEM prompt on BuildShip so a stale client cannot bypass
  // them. The only remaining gate is the missing-class check below.

  // A Code File's path is author-controlled in FlutterFlow, so a file name that
  // disagrees with the declared class is a naming convention, not something
  // FlutterFlow rejects. It stays a review warning and no longer blocks here.

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a file map before commit.
 * @param {Map<string, Object>} fileMap - Map of file paths to file info
 * @returns {Object} Validation result { valid: boolean, errors: string[], warnings: string[] }
 */
function validateFileMap(fileMap) {
  const errors = [];
  const warnings = [];

  if (!fileMap || fileMap.size === 0) {
    errors.push("No files to commit");
    return { valid: false, errors, warnings };
  }

  const declaredTypes = new Set(
    Array.from(fileMap.values()).flatMap((fileInfo) =>
      getDeclaredDartTypes(fileInfo.content || "")
    ),
  );

  for (const [path, fileInfo] of fileMap.entries()) {
    // Check for empty files
    if (!fileInfo.content || fileInfo.content.trim().length === 0) {
      errors.push(`File ${path} is empty`);
    }

    // Check file size (FlutterFlow may have limits)
    if (fileInfo.content && fileInfo.content.length > 100000) {
      warnings.push(`File ${path} is very large (>100KB)`);
    }

    // Validate Dart files
    if (path.endsWith(".dart")) {
      const result = validateDartFile(
        path,
        fileInfo.content,
        fileInfo.type,
        declaredTypes,
        fileInfo.artifactName,
      );
      if (!result.valid) {
        errors.push(...result.errors.map((e) => `${path}: ${e}`));
      }
    }

    // Validate pubspec
    if (path === "pubspec.yaml") {
      const result = validateProjectPubspec(fileInfo.content);
      if (!result.valid) {
        errors.push(...result.errors);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
// --- COMMIT STATE MANAGEMENT ---

/**
 * Commit operation states
 */
const CommitState = {
  IDLE: "IDLE",
  PREPARING: "PREPARING",
  VALIDATING: "VALIDATING",
  PUSHING: "PUSHING",
  SUCCESS: "SUCCESS",
  ERROR: "ERROR",
};

/**
 * Global commit state tracking object
 */
const commitState = {
  currentState: CommitState.IDLE,
  startTime: null,
  endTime: null,
  error: null,
  result: null,
  filesProcessed: 0,
  totalFiles: 0,

  /**
   * Reset state to idle
   */
  reset() {
    this.currentState = CommitState.IDLE;
    this.startTime = null;
    this.endTime = null;
    this.error = null;
    this.result = null;
    this.filesProcessed = 0;
    this.totalFiles = 0;
  },

  /**
   * Set current state
   * @param {string} state - New state from CommitState
   */
  setState(state) {
    if (!Object.values(CommitState).includes(state)) {
      console.error(`Invalid commit state: ${state}`);
      return;
    }

    this.currentState = state;

    if (state === CommitState.PREPARING) {
      this.startTime = Date.now();
    }

    if (state === CommitState.SUCCESS || state === CommitState.ERROR) {
      this.endTime = Date.now();
    }

    // Trigger state change event
    if (typeof window !== "undefined" && window.dispatchEvent) {
      window.dispatchEvent(
        new CustomEvent("commitStateChange", {
          detail: { state, commitState: this },
        }),
      );
    }

    console.log(`Commit state changed to: ${state}`);
  },

  /**
   * Set error information
   * @param {Error} error - Error object
   */
  setError(error) {
    this.error = error;
    this.setState(CommitState.ERROR);
  },

  /**
   * Set success result
   * @param {Object} result - Success result data
   */
  setSuccess(result) {
    this.result = result;
    this.setState(CommitState.SUCCESS);
  },

  /**
   * Update file progress
   * @param {number} processed - Number of files processed
   * @param {number} total - Total number of files
   */
  setProgress(processed, total) {
    this.filesProcessed = processed;
    this.totalFiles = total;
  },

  /**
   * Get elapsed time in milliseconds
   * @returns {number|null} Elapsed time or null if not started
   */
  getElapsedTime() {
    if (!this.startTime) return null;
    const end = this.endTime || Date.now();
    return end - this.startTime;
  },

  /**
   * Check if commit is in progress
   * @returns {boolean} True if committing
   */
  isInProgress() {
    return (
      this.currentState === CommitState.PREPARING ||
      this.currentState === CommitState.VALIDATING ||
      this.currentState === CommitState.PUSHING
    );
  },
};

/**
 * Commits generated code to FlutterFlow with full state tracking.
 * @param {string} dartCode - The generated Dart code to commit
 * @param {string} fileName - Name of the file (e.g., "MyWidget.dart")
 * @param {Object} options - Commit options
 * @param {string} options.codeType - Type of code (ACTION, WIDGET, FUNCTION)
 * @param {Object} options.pubspecDeps - Additional pubspec dependencies
 * @returns {Promise<Object>} Commit result
 */
async function commitToFlutterFlow(dartCode, fileName, options = {}) {
  let { codeType = "W" } = options;
  const { pubspecDeps = {}, artifactName = fileName } = options;

  // Validate/fix codeType if passed as full string
  if (codeType === "CustomWidget") codeType = CodeType.WIDGET;
  if (codeType === "CustomAction") codeType = CodeType.ACTION;
  if (codeType === "CustomFunction") codeType = CodeType.FUNCTION;
  if (codeType === "CustomClass") codeType = CodeType.CODE_FILE;
  if (codeType === "CodeFile") codeType = CodeType.CODE_FILE;

  // Reset and start
  commitState.reset();
  commitState.setState(CommitState.PREPARING);

  try {
    // Get credentials
    const apiKey = await getApiKey("flutterflow");
    const projectId = await getApiKey("flutterflow_project_id");

    if (!apiKey || !projectId) {
      throw new Error(
        "FlutterFlow credentials not configured. Please set your API key and Project ID in the API Keys settings.",
      );
    }

    if (!validateFlutterFlowProjectId(projectId)) {
      throw new Error("Invalid FlutterFlow Project ID format.");
    }

    const endpoint = getFlutterFlowEndpoint();
    const apiClient = new FlutterFlowApiClient(
      apiKey,
      projectId,
      "main",
      endpoint,
    );

    // Prepare file map
    commitState.setState(CommitState.VALIDATING);
    const fileMap = new Map();

    // Add the main code file
    const detectedType = codeType || detectCodeType(fileName, dartCode);
    const filePath = getFilePathForCodeType(fileName, detectedType);

    fileMap.set(fileName, {
      artifactName,
      content: dartCode,
      type: detectedType,
      path: filePath,
    });

    commitState.setProgress(0, fileMap.size);

    // Validate files
    const validation = validateFileMap(fileMap);
    if (!validation.valid) {
      throw new Error(`Validation failed:\n${validation.errors.join("\n")}`);
    }

    // Read the project's pubspec.yaml, add whatever the code needs, and push
    // the merged file back so existing packages are preserved.
    const pubspecMerge = await resolveProjectPubspec(apiClient, pubspecDeps);
    const serializedYaml = pubspecMerge.yaml;
    const provisioning = await provisionMissingCodeFiles(
      apiClient,
      fileMap,
      pubspecMerge.remoteFiles,
      `Provision ${artifactName} custom class`,
      serializedYaml,
    );

    const syncMetadata = await buildApiSyncMetadata(
      provisioning.syncFileMap,
      provisioning.remoteFiles,
    );

    const fileMapWithPubspec = new Map(provisioning.syncFileMap);
    fileMapWithPubspec.set("pubspec.yaml", {
      content: serializedYaml,
      type: "D",
      path: "pubspec.yaml",
    });

    commitProgress.set("package");
    const zippedCustomCode = await createZipFromFileMap(fileMapWithPubspec);

    const pushRequest = {
      project_id: projectId,
      zipped_custom_code: zippedCustomCode,
      uid: `web_${Date.now()}`,
      branch_name: apiClient.branchName,
      serialized_yaml: serializedYaml,
      file_map: syncMetadata.fileMapContents,
      functions_map: syncMetadata.functionsMapContents,
    };

    // Push to FlutterFlow
    commitState.setState(CommitState.PUSHING);
    commitState.setProgress(1, fileMap.size);

    // A push can change custom code, functions, or dependencies even when its
    // response is lost, so the exported project snapshot is now stale.
    invalidateProjectSourceCache(apiClient);

    commitProgress.set("push");
    const response = await apiClient.pushCode(pushRequest);
    const result = await parsePushCodeResponse(response);

    if (result.success) {
      commitState.setSuccess({
        fileCount: fileMap.size,
        projectId,
        warnings:
          result.errorMap && result.errorMap.size > 0
            ? Array.from(result.errorMap.entries())
            : [],
      });
    } else {
      const errorMsg =
        result.errorMessage || getFlutterFlowErrorMessage(result.responseCode);
      throw new Error(errorMsg);
    }

    return {
      success: true,
      message: `Successfully committed ${fileName} to FlutterFlow project ${projectId}`,
      addedDependencies: pubspecMerge.added,
      unverified: provisioning.unverified,
      approximate: provisioning.approximate,
      warnings: result.errorMap ? Array.from(result.errorMap.entries()) : [],
    };
  } catch (error) {
    console.error("Commit failed:", error);
    commitState.setError(error);

    return {
      success: false,
      error: error.message,
      state: commitState.currentState,
    };
  }
}

/**
 * Executes the complete commit action with all integrations.
 * @param {string} code - Generated Dart code
 * @param {Object} options - Commit options
 * @param {string} options.artifactType - Type of artifact
 * @param {string} options.artifactName - Name of artifact
 * @param {Object} options.pipelineResult - Pipeline generation results
 * @returns {Promise<Object>} Commit result with full details
 */

async function createZipFromFileMap(fileMap) {
  // No error swallowing here: a failed zip used to return "" and the push
  // would send an empty archive, turning a local packaging bug into an opaque
  // FlutterFlow rejection. Every caller already runs inside a try/catch that
  // surfaces the failure, so let the error propagate with its real cause.
  const zip = new JSZip();

  for (const [name, info] of fileMap.entries()) {
    zip.file(name, info.content);
  }

  return zip.generateAsync({
    type: "base64",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function executeCommit(code, options = {}) {
  const { artifactType, artifactName, fileName, pipelineResult } = options;

  console.log(`Starting commit for ${artifactName} (${artifactType})`);

  // Written before the try so the catch can decide partial vs failed: once the
  // runner has upserted custom classes, a failure of the remaining sync is a
  // genuine partial outcome, not a clean total failure.
  let provisionClassesWritten = false;
  const targetIdentity = {
    projectId: null,
    endpoint: getFlutterFlowEndpoint(),
    artifactType,
    artifactName,
    fileName,
  };

  try {
    // Step 1: Prepare the code
    commitState.setState(CommitState.PREPARING);
    const codeInfo = prepareCodeForCommit(code, { artifactType, artifactName, fileName });

    // Step 2: Extract dependencies
    const deps = extractDependencies(codeInfo.content);
    console.log("Detected dependencies:", deps);

    // Step 3: Validate FlutterFlow credentials
    commitState.setState(CommitState.VALIDATING);
    const apiKey = await getApiKey("flutterflow");
    const projectId =
      commitTargetProjectId || (await getApiKey("flutterflow_project_id"));

    if (!apiKey) {
      throw new Error(
        "FlutterFlow API Key not configured. Please add it in API Keys settings.",
      );
    }
    if (!projectId) {
      throw new Error(
        "FlutterFlow Project ID not configured. Please add it in API Keys settings.",
      );
    }

    if (!validateFlutterFlowProjectId(projectId)) {
      throw new Error("Invalid FlutterFlow Project ID format.");
    }

    // Step 5: Prepare file map
    const fileMap = new Map();
    fileMap.set(codeInfo.fileName, {
      artifactName,
      content: codeInfo.content,
      type: codeInfo.codeType,
      path: getFilePathForCodeType(codeInfo.fileName, codeInfo.codeType),
      functionName:
        codeInfo.codeType === CodeType.FUNCTION ? artifactName : undefined,
    });

    commitState.setProgress(0, fileMap.size);

    // Step 6: Validate files
    const validation = validateFileMap(fileMap);
    if (!validation.valid) {
      throw new Error(
        `File validation failed:\n${validation.errors.join("\n")}`,
      );
    }

    if (validation.warnings.length > 0) {
      console.warn("Validation warnings:", validation.warnings);
    }

    commitState.setState(CommitState.PUSHING);
    const endpoint = getFlutterFlowEndpoint();
    const apiClient = new FlutterFlowApiClient(
      apiKey,
      projectId,
      "main",
      endpoint,
    );

    // Step 7: Merge the code's dependencies into the project's own pubspec.yaml
    const pubspecMerge = await resolveProjectPubspec(apiClient, deps);
    const serializedYaml = pubspecMerge.yaml;
    const provisioning = await provisionMissingCodeFiles(
      apiClient,
      fileMap,
      pubspecMerge.remoteFiles,
      `Provision ${artifactName} custom class`,
      serializedYaml,
    );
    targetIdentity.projectId = projectId;
    provisionClassesWritten = provisioning.provisionSucceeded === true;

    const syncMetadata = await buildApiSyncMetadata(
      provisioning.syncFileMap,
      provisioning.remoteFiles,
    );

    const fileMapWithPubspec = new Map(provisioning.syncFileMap);
    fileMapWithPubspec.set("pubspec.yaml", {
      content: serializedYaml,
      type: CodeType.DEPENDENCIES,
      path: "pubspec.yaml",
    });

    commitProgress.set("package");
    const zippedCustomCode = await createZipFromFileMap(fileMapWithPubspec);

    const pushRequest = {
      project_id: projectId,
      zipped_custom_code: zippedCustomCode,
      uid: `web_${Date.now()}`,
      branch_name: apiClient.branchName,
      serialized_yaml: serializedYaml,
      file_map: syncMetadata.fileMapContents,
      functions_map: syncMetadata.functionsMapContents,
    };

    commitState.setProgress(1, fileMap.size);

    // A push can change custom code, functions, or dependencies even when its
    // response is lost, so the exported project snapshot is now stale.
    invalidateProjectSourceCache(apiClient);

    commitProgress.set("push");
    const response = await apiClient.pushCode(pushRequest);
    const result = await parsePushCodeResponse(response);

    // Step 10: Handle result
    if (result.success) {
      const metadata = { ...buildCommitMetadata(codeInfo, pipelineResult), projectId };

      commitState.setSuccess({
        ...metadata,
        fileCount: fileMap.size,
        warnings: result.errorMap ? Array.from(result.errorMap.entries()) : [],
      });

      return {
        success: true,
        message: `Successfully committed ${codeInfo.fileName} to FlutterFlow`,
        metadata,
        targetIdentity,
        addedDependencies: pubspecMerge.added,
        unverified: provisioning.unverified,
        approximate: provisioning.approximate,
        warnings: result.errorMap ? Array.from(result.errorMap.entries()) : [],
        elapsedTime: commitState.getElapsedTime(),
      };
    } else {
      const errorMsg =
        result.errorMessage || getFlutterFlowErrorMessage(result.responseCode);
      const errorWithMap = new Error(errorMsg);
      errorWithMap.errorMap = result.errorMap;
      throw errorWithMap;
    }
  } catch (error) {
    console.error("Commit execution failed:", error);
    commitState.setError(error);

    // Try to extract errorMap from the error if available
    let errorMap = new Map();
    if (error.errorMap) {
      errorMap = error.errorMap;
    } else if (error.message && error.message.includes("{")) {
      // Try to parse errorMap from error message
      try {
        const match = error.message.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          errorMap = new Map(Object.entries(parsed));
        }
      } catch (e) {
        console.warn("Failed to parse error map from commit response:", e);
      }
    }

    // A client-side wait expiry or a dropped stream means the remote outcome
    // is unknown: report unconfirmed, never fabricated failed or committed.
    if (error instanceof UnconfirmedDeployError) {
      return {
        success: false,
        unconfirmed: true,
        error: error.message,
        errorMap,
        targetIdentity,
        state: commitState.currentState,
        elapsedTime: commitState.getElapsedTime(),
      };
    }

    // Custom classes were already upserted but the remaining sync failed:
    // that is a partial outcome, and concealing the written classes would lie.
    if (provisionClassesWritten) {
      return {
        success: false,
        partial: true,
        error: error.message,
        errorMap,
        targetIdentity,
        state: commitState.currentState,
        elapsedTime: commitState.getElapsedTime(),
      };
    }

    return {
      success: false,
      error: error.message,
      errorMap: errorMap,
      targetIdentity,
      state: commitState.currentState,
      elapsedTime: commitState.getElapsedTime(),
    };
  }
}

async function executeBundleCommit(bundlePlan, options = {}) {
  const { pipelineResult } = options;

  let provisionClassesWritten = false;
  const targetIdentity = {
    projectId: null,
    endpoint: getFlutterFlowEndpoint(),
    artifactType: "Bundle",
    artifactName: bundlePlan?.title,
    fileName: bundlePlan?.fileEntries
      ? `${bundlePlan.fileEntries.length} artifacts`
      : "bundle",
  };

  try {
    commitState.setState(CommitState.PREPARING);
    if (bundlePlan.errors?.length > 0) {
      throw new Error(`Bundle validation failed:\n${bundlePlan.errors.join("\n")}`);
    }
    const fileMap = new Map(
      bundlePlan.fileEntries.map((entry) => [
        entry.fileName,
        {
          artifactId: entry.artifactId,
          artifactName: entry.artifactName,
          content: entry.content,
          type: entry.type,
          path: entry.path,
          functionName:
            entry.type === CodeType.FUNCTION
              ? entry.artifactName
              : undefined,
        },
      ]),
    );

    commitState.setProgress(0, fileMap.size);

    const validation = validateFileMap(fileMap);
    if (!validation.valid) {
      throw new Error(`File validation failed:\n${validation.errors.join("\n")}`);
    }

    commitState.setState(CommitState.VALIDATING);
    const apiKey = await getApiKey("flutterflow");
    const projectId =
      commitTargetProjectId || (await getApiKey("flutterflow_project_id"));

    if (!apiKey) {
      throw new Error("FlutterFlow API Key not configured. Please add it in API Keys settings.");
    }
    if (!projectId) {
      throw new Error("FlutterFlow Project ID not configured. Please add it in API Keys settings.");
    }
    if (!validateFlutterFlowProjectId(projectId)) {
      throw new Error("Invalid FlutterFlow Project ID format.");
    }

    commitState.setState(CommitState.PUSHING);
    const endpoint = getFlutterFlowEndpoint();
    const apiClient = new FlutterFlowApiClient(
      apiKey,
      projectId,
      "main",
      endpoint,
    );

    const pubspecMerge = await resolveProjectPubspec(
      apiClient,
      bundlePlan.dependencies,
    );
    const serializedYaml = pubspecMerge.yaml;
    const provisioning = await provisionMissingCodeFiles(
      apiClient,
      fileMap,
      pubspecMerge.remoteFiles,
      `Provision ${bundlePlan.title} custom classes`,
      serializedYaml,
    );
    targetIdentity.projectId = projectId;
    provisionClassesWritten = provisioning.provisionSucceeded === true;
    const syncMetadata = await buildApiSyncMetadata(
      provisioning.syncFileMap,
      provisioning.remoteFiles,
    );

    const fileMapWithPubspec = new Map(provisioning.syncFileMap);
    fileMapWithPubspec.set("pubspec.yaml", {
      content: serializedYaml,
      type: CodeType.DEPENDENCIES,
      path: "pubspec.yaml",
    });

    commitProgress.set("package");
    const zippedCustomCode = await createZipFromFileMap(fileMapWithPubspec);
    const pushRequest = {
      project_id: projectId,
      zipped_custom_code: zippedCustomCode,
      uid: `web_${Date.now()}`,
      branch_name: apiClient.branchName,
      serialized_yaml: serializedYaml,
      file_map: syncMetadata.fileMapContents,
      functions_map: syncMetadata.functionsMapContents,
    };

    commitState.setProgress(1, fileMap.size);
    // A push can change custom code, functions, or dependencies even when its
    // response is lost, so the exported project snapshot is now stale.
    invalidateProjectSourceCache(apiClient);

    commitProgress.set("push");
    const response = await apiClient.pushCode(pushRequest);
    const result = await parsePushCodeResponse(response);

    if (result.success) {
      const metadata = {
        ...pipelineResult,
        artifactType: "Bundle",
        artifactName: bundlePlan.title,
        fileName: `${bundlePlan.fileEntries.length} artifacts`,
        codeSize: bundlePlan.fileEntries.reduce((sum, entry) => sum + entry.content.length, 0),
        projectId,
      };

      commitState.setSuccess({
        ...metadata,
        fileCount: fileMap.size,
        warnings: result.errorMap ? Array.from(result.errorMap.entries()) : [],
      });

      return {
        success: true,
        message: `Successfully committed ${bundlePlan.fileEntries.length} artifacts to FlutterFlow`,
        metadata,
        targetIdentity,
        addedDependencies: pubspecMerge.added,
        unverified: provisioning.unverified,
        approximate: provisioning.approximate,
        warnings: result.errorMap ? Array.from(result.errorMap.entries()) : [],
        elapsedTime: commitState.getElapsedTime(),
      };
    }

    const errorMsg = result.errorMessage || getFlutterFlowErrorMessage(result.responseCode);
    const errorWithMap = new Error(errorMsg);
    errorWithMap.errorMap = result.errorMap;
    throw errorWithMap;
  } catch (error) {
    console.error("Bundle commit execution failed:", error);
    commitState.setError(error);

    const errorMap = error.errorMap || new Map();

    if (error instanceof UnconfirmedDeployError) {
      return {
        success: false,
        unconfirmed: true,
        error: error.message,
        errorMap,
        targetIdentity,
        state: commitState.currentState,
        elapsedTime: commitState.getElapsedTime(),
      };
    }

    if (provisionClassesWritten) {
      return {
        success: false,
        partial: true,
        error: error.message,
        errorMap,
        targetIdentity,
        state: commitState.currentState,
        elapsedTime: commitState.getElapsedTime(),
      };
    }

    return {
      success: false,
      error: error.message,
      errorMap,
      targetIdentity,
      state: commitState.currentState,
      elapsedTime: commitState.getElapsedTime(),
    };
  }
}

// --- PIPELINE FUNCTIONS ---

async function runPromptArchitect(userInput, images = []) {
  const context = createBuildShipContext("architect")
  try {
    const result = await callBuildShip(
      "architect",
      PROMPT_ARCHITECT_MODEL,
      buildArchitectPrompt(userInput),
      context,
      images,
    )
    return result
  } catch (error) {
    if (error.isModelArmor) throw error
    // An exhausted allowance must keep its marker or the failure view loses
    // the upgrade action and stage attribution.
    if (error.isUsageLimit) throw error
    // A cancelled request is a stale run, not a stage failure.
    if (error.isPipelineCancel) throw error
    throw new Error(`Prompt Architect failed: ${error.message}`)
  }
}

async function runCodeGenerator(masterPrompt, selectedModel, images = [], runId) {
  const prompt = buildGeneratorPrompt(masterPrompt)
  const context = createBuildShipContext("generator", pipelineState.bundleSpec)
  try {
    const result = await callBuildShip("generator", selectedModel, prompt, context, images)
    return result
  } catch (primaryError) {
    if (primaryError.isModelArmor) throw primaryError
    // An exhausted allowance is not a model problem: retrying on the fallback
    // model would spend another request and lose the quota signal the view
    // needs to offer an upgrade.
    if (primaryError.isUsageLimit) throw primaryError
    // A cancelled request is a stale run, not a model problem: it must not
    // trigger a second request on the fallback model.
    if (primaryError.isPipelineCancel) throw primaryError
    if (selectedModel !== FALLBACK_MODEL) {
      console.warn(`Code Generator failed with ${selectedModel}, retrying with fallback model:`, primaryError.message)
      // The fallback is a real service event, so the run says so while it
      // continues rather than silently swapping models behind the progress.
      notePipelineFallback(selectedModel, FALLBACK_MODEL, runId)
      try {
        const result = await callBuildShip("generator", FALLBACK_MODEL, prompt, context, images)
        return result
      } catch (fallbackError) {
        if (fallbackError.isModelArmor) throw fallbackError
        // A quota refusal on the fallback is terminal the same way it was on
        // the primary: wrap it and the upgrade affordance is lost.
        if (fallbackError.isUsageLimit) throw fallbackError
        if (fallbackError.isPipelineCancel) throw fallbackError
        throw new Error(`Code Generator failed: primary (${selectedModel}): ${primaryError.message} | fallback (${FALLBACK_MODEL}): ${fallbackError.message}`)
      }
    }
    throw new Error(`Code Generator failed: ${primaryError.message}`)
  }
}

async function runCodeReview(code, architectOutput = null) {
  const context = {
    ...createBuildShipContext("review", pipelineState.artifactBundle || pipelineState.bundleSpec),
    architect_output: architectOutput,
  }
  try {
    const result = await callBuildShip("review", CODE_REVIEW_MODEL, buildReviewPrompt(code), context)
    return result
  } catch (error) {
    if (error.isModelArmor) throw error
    // An exhausted allowance must keep its marker or the failure view loses
    // the upgrade action and stage attribution.
    if (error.isUsageLimit) throw error
    if (error.isPipelineCancel) throw error
    throw new Error(`Code Review failed: ${error.message}`)
  }
}

function getPipelineErrorMessage(error, prefix) {
  if (error.isModelArmor) {
    return `${error.userTitle}: ${error.userMessage}`;
  }
  return `${prefix}: ${error.message}`;
}

// --- MARKDOWN RENDERING ---

// --- UI FUNCTIONS ---

function updateStepIndicator(step, status) {
  const item = document.getElementById(`step${step}-item`);
  const statusIcon = document.getElementById(`step${step}-status`);
  if (!item || !statusIcon) return;

  // Reset classes
  item.classList.remove("active", "completed", "error");
  statusIcon.classList.remove("running", "completed", "error");

  if (status === "active") {
    item.classList.add("active");
    statusIcon.classList.add("running");
    // Spinner icon for running state
    statusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
    </svg>`;
  } else if (status === "completed") {
    item.classList.add("completed");
    statusIcon.classList.add("completed");
    // Checkmark icon for completed state
    statusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>`;
  } else if (status === "error") {
    item.classList.add("error");
    statusIcon.classList.add("error");
    // X icon for error state
    statusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>`;
  } else {
    // Reset to clock icon (pending state)
    statusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>`;
  }
}

function showStepLoading(step, show) {
  const loading = document.getElementById(`step${step}-loading`);
  const result = document.getElementById(`step${step}-result`);

  if (show) {
    loading.classList.remove("hidden");
    result.classList.add("hidden");
    updateStepIndicator(step, "active");
  } else {
    loading.classList.add("hidden");
    result.classList.remove("hidden");
    updateStepIndicator(step, "completed");
  }
}

function toggleSection(sectionId) {
  const content = document.getElementById(`${sectionId}-content`);
  const chevron = document.getElementById(`${sectionId}-chevron`);

  if (content.classList.contains("open")) {
    content.classList.remove("open");
    if (chevron) chevron.style.transform = "rotate(0deg)";
  } else {
    content.classList.add("open");
    if (chevron) chevron.style.transform = "rotate(180deg)";
  }
}

function toggleStep(step) {
  // For backward compatibility - now we show the step in main stage
  selectWorkflowStep(parseInt(step.replace("step", "")));
}

function selectWorkflowStep(step) {
  // Remove active class from all workflow items
  for (let i = 1; i <= 3; i++) {
    const item = document.getElementById(`step${i}-item`);
    if (item) item.classList.remove("active");
  }

  // Add active class to selected workflow item
  const selectedItem = document.getElementById(`step${step}-item`);
  if (selectedItem) selectedItem.classList.add("active");

  // Hide welcome video
  dismissWelcomeVideo();

  // Hide ready state
  const readyState = document.getElementById("ready-state");
  if (readyState) readyState.classList.add("hidden");

  // Hide all step contents
  for (let i = 1; i <= 3; i++) {
    const content = document.getElementById(`step${i}-content`);
    if (content) content.classList.add("hidden");
  }

  // Show selected step content
  const selectedContent = document.getElementById(`step${step}-content`);
  if (selectedContent) selectedContent.classList.remove("hidden");

  // Update stage title
  const stageTitle = document.getElementById("stage-title");
  const titles = {
    1: "Prompt Architect",
    2: "Code Generator",
    3: "Code Review",
  };
  if (stageTitle)
    stageTitle.textContent = titles[step] || "Active Workflow Stage";
}

function copyCode(elementId) {
  const element = document.getElementById(elementId);
  if (!element) return;

  // Use stored raw code if available, otherwise use textContent
  const text = element.dataset.raw || element.textContent;
  navigator.clipboard
    .writeText(text)
    .then(() => {
      trackEvent("Code Copied", { elementId });
      
      // Find the copy button for this element
      const container = element.closest(".code-container");
      const btn = container?.querySelector(".copy-btn");
      if (btn) {
        btn.classList.add("copied");
        btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Copied!`;
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg> Copy`;
        }, 2000);
      }
    })
    .catch((err) => {
      console.warn("Failed to copy to clipboard:", err);
    });
}

// The workflow steps deliberately no longer name the model that runs each one -
// which model handles Prompt Architect, Code Generator or Code Review is our
// call, not something the user has to reason about. Logging stays for support.
function updateModelInfo(selectedModel) {
  const effectiveModel = getEffectiveModel(selectedModel)

  console.log(`Step 1 (Prompt Architect): ${getModelLabel(PROMPT_ARCHITECT_MODEL)}`)
  if (effectiveModel !== selectedModel) {
    console.log(`Step 2 (Code Generator): ${getModelLabel(selectedModel)} → ${getModelLabel(effectiveModel)} (Free Tier fallback)`)
  } else {
    console.log(`Step 2 (Code Generator): ${getModelLabel(selectedModel)}`)
  }
  console.log(`Step 3 (Code Review): ${getModelLabel(CODE_REVIEW_MODEL)}`)
}

/**
 * Snapshot the current successful generation result so a failed refinement or
 * build-error replacement can restore it verbatim. The selected artifact, full
 * bundle, prompt, review and selection are held untouched until a replacement
 * generation AND review both succeed.
 */
function snapshotGenerationResult() {
  return {
    step1Result: pipelineState.step1Result,
    step2Result: pipelineState.step2Result,
    step3Result: pipelineState.step3Result,
    artifactBundle: pipelineState.artifactBundle,
    bundleReview: pipelineState.bundleReview,
    selectedArtifactId: pipelineState.selectedArtifactId,
  };
}

/**
 * Bring a prior successful result back into shared state and reconcile the
 * selection to an id that still exists in the restored bundle (so the prior
 * result never points at a stale artifact that the failed replacement no
 * longer defined).
 */
function restoreGenerationResult(snapshot) {
  if (!snapshot) return;
  Object.assign(pipelineState, snapshot);
  const ids = new Set((pipelineState.artifactBundle?.artifacts || []).map((a) => a.id));
  if (!ids.has(pipelineState.selectedArtifactId)) {
    pipelineState.selectedArtifactId =
      getPrimaryArtifact(pipelineState.artifactBundle)?.id || null;
  }
}

const RESULTS_REPLACEMENT_ERROR_ID = "results-replacement-error";

/** Persistent error + retry UI that sits over the retained previous result. */
function showReplacementFailure(error, { stage = 2, runId, retry }) {
  if (!isCurrentPipelineRun(runId)) return;
  const banner = document.getElementById(RESULTS_REPLACEMENT_ERROR_ID);
  if (!banner) return;
  const failure = classifyPipelineError(error);
  const titleEl = document.getElementById("results-replacement-error-title");
  const messageEl = document.getElementById("results-replacement-error-message");
  const retryEl = document.getElementById("results-replacement-error-retry");
  const upgradeEl = document.getElementById("results-replacement-error-upgrade");
  if (titleEl) titleEl.textContent = `${PIPELINE_STAGE_LABELS[stage] || "Regeneration"}: ${failure.title}`;
  if (messageEl) messageEl.textContent = failure.message;
  banner.hidden = false;

  // A quota/usage-limit rejection is the one failure a protected retry cannot
  // fix — re-firing launches another generation into an already-exhausted
  // allowance, a dead end. Surface the upgrade affordance as the primary
  // action, exactly as the non-replacement path does. Every other failure
  // keeps the retry.
  let focusTarget = null;
  if (upgradeEl) {
    upgradeEl.hidden = !failure.canUpgrade;
    if (failure.canUpgrade) {
      upgradeEl.textContent = "View plans";
      upgradeEl.onclick = () => openPricingModal();
      focusTarget = upgradeEl;
    }
  }
  if (retryEl) {
    retryEl.hidden = failure.canUpgrade;
    if (!failure.canUpgrade) {
      retryEl.onclick = () => {
        hideReplacementFailure();
        if (typeof retry === "function") retry();
      };
      retryEl.textContent = "Retry";
      focusTarget = retryEl;
    }
  }
  // Keyboard accessible: a failed replacement lands focus on the action that
  // can actually resolve it.
  (focusTarget || banner).focus({ preventScroll: true });
}

function hideReplacementFailure() {
  const banner = document.getElementById(RESULTS_REPLACEMENT_ERROR_ID);
  if (banner) banner.hidden = true;
}

/**
 * Shared completion path for a replacement run (refinement / build-error fix):
 * the previous successful result is restored verbatim, the Results surface is
 * repainted from it, and a persistent error + retry banner is shown. A toast
 * alone is insufficient - the old code and review must stay inspectable and
 * copyable while the user decides whether to retry.
 */
function restoreAndShowReplacementFailure(error, { previous, stage, runId, retry }) {
  if (!isCurrentPipelineRun(runId)) return;
  if (error.isUsageLimit) updateUsageDisplay();
  restoreGenerationResult(previous);
  hidePipelineProgress();
  setGenerationStageVisible(true);
  showResultsView();
  updateSelectedArtifactPanels();
  showReplacementFailure(error, { stage, runId, retry });
  updateDeployButtonVisibility();
}

async function runRefinement() {
  console.log("runRefinement called");

  if (pipelineState.isRunning) return;

  // Get current model
  const selectedModel = document.getElementById("code-generator-model").value;

  // Set running state
  pipelineState.isRunning = true;
  const runId = startPipelineRun();
  callEndpoint('standardRegenerate', pipelineState.step2Result, pipelineState.step1Result)
  const btns = document.querySelectorAll(".btn-refine-action");

  // Hold the prior successful result verbatim until a replacement generation
  // AND review both succeed; a failure restores it below.
  const previousResult = snapshotGenerationResult();

  btns.forEach((btn) => {
    btn.disabled = true;
    btn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
      </svg>
      Refining...`;
  });

  try {
    hideReplacementFailure();
    const selectedArtifact = getSelectedArtifact();
    const refinedArtifactId = selectedArtifact.id;
    const refinementPrompt = buildArtifactRegenerationPrompt({
      bundleSpec: pipelineState.step1Result,
      artifactBundle: JSON.stringify(pipelineState.artifactBundle || pipelineState.step2Result),
      bundleReview: pipelineState.step3Result,
      artifactId: selectedArtifact.id,
      userFeedback: "Fix the issues listed in the audit report.",
    });

    // Show progress bar for refinement. The run was already claimed above,
    // so a late response from an older run cannot overwrite this one.
    showPipelineProgress({ runId });
    updatePipelineProgressStep(2, runId);

    // Step 2: Code Generator (Refinement)
    selectWorkflowStep(2);
    showStepLoading(2, true);

    // We use the same runCodeGenerator function but with the refinement
    // prompt. Stage results commit to shared state only after the run is
    // revalidated, so an abandoned run cannot overwrite a newer one.
    const step2Result = await runCodeGenerator(
      refinementPrompt,
      selectedModel,
      [],
      runId,
    );
    if (!isCurrentPipelineRun(runId)) return;
    pipelineState.step2Result = step2Result;
    updateArtifactBundleFromGeneratedCode();
    completePipelineStage(2, runId);

    const step2Output = document.getElementById("step2-output");
    const cleanStep2 = extractCodeFromMarkdown(pipelineState.step2Result);
    step2Output.textContent = cleanStep2;
    step2Output.dataset.raw = cleanStep2;
    showStepLoading(2, false);

    // Step 3: Code Audit (Re-audit)
    selectWorkflowStep(3);
    updatePipelineProgressStep(3, runId);
    showStepLoading(3, true);

    const step3Result = await runCodeReview(
      pipelineState.step2Result,
      pipelineState.step1Result,
    );
    if (!isCurrentPipelineRun(runId)) return;
    pipelineState.step3Result = step3Result;
    updateBundleReviewFromReviewResult();
    completePipelineStage(3, runId);

    // The whole replacement (generation + review) succeeded, so the new result
    // is committed. Reconcile the selection onto the re-refined artifact if it
    // still exists, otherwise fall back to the new bundle's primary — either
    // way the tabs are rebuilt from the new bundle, so none go stale.
    if (pipelineState.artifactBundle?.artifacts?.some((a) => a.id === refinedArtifactId)) {
      pipelineState.selectedArtifactId = refinedArtifactId;
    } else {
      pipelineState.selectedArtifactId = getPrimaryArtifact(pipelineState.artifactBundle)?.id || null;
    }

    const auditOutput = document.getElementById("step3-output");
    auditOutput.textContent = pipelineState.step3Result;

    showStepLoading(3, false);

    // Show updated results
    hidePipelineProgress();
    const auditHtml = renderMarkdownAudit(pipelineState.step3Result);
    showResultsView(cleanStep2, auditHtml);
  } catch (error) {
    console.error("Refinement failed:", error);
    if (!isCurrentPipelineRun(runId)) return;

    const errorStep = resolvePipelineErrorStep(error, {
      architect: 2,
      generator: 2,
      review: 3,
    });

    // Restore the previous successful result and keep it visible and copyable
    // with persistent error + retry UI; the failed replacement never owns the
    // screen.
    restoreAndShowReplacementFailure(error, {
      previous: previousResult,
      stage: errorStep,
      runId,
      retry: runRefinement,
    });
  } finally {
    // The control's own busy affordance is restored even for an abandoned
    // run — the run guard only protects shared pipeline state.
    btns.forEach((btn) => {
      btn.disabled = false;
      btn.textContent = "Refine & Regenerate";
    });
    if (isCurrentPipelineRun(runId)) {
      pipelineState.isRunning = false;
      updateDeployButtonVisibility();
    }
  }
}

async function callEndpoint(type, code, input) {
  const url = `${BUILDSHIP_BASE_URL}/connectFeedback`
  const data = { type: type, code: code, input: input }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error(`callEndpoint failed: ${response.status} ${response.statusText}`, errorText)
      return { success: false, status: response.status, error: errorText }
    }
    
    const result = await response.json()
    console.log('Telemetry success:', result)
    return result
  } catch (error) {
    console.error('callEndpoint failed:', error)
    return { success: false, error: error.message }
  }
}

function clearErrorInput() {
  const input = document.getElementById("ff-error-paste-input")
  if (input) input.value = ""
}

async function regenerateFromPastedErrors() {
  const input = document.getElementById("ff-error-paste-input")
  const pastedErrors = input?.value?.trim()

  if (!pastedErrors) {
    input?.focus()
    input?.classList.add("ring-2", "ring-red-400", "border-red-300")
    setTimeout(() => input?.classList.remove("ring-2", "ring-red-400", "border-red-300"), 2000)
    return
  }

  if (!pipelineState.step2Result) {
    showToast("No generated code found. Please run the full pipeline first.", "warning")
    return
  }

  if (pipelineState.isRunning) return

  const selectedModel = document.getElementById("code-generator-model").value
  pipelineState.isRunning = true
  const runId = startPipelineRun()
  callEndpoint('flutterflowError', pipelineState.step2Result, pastedErrors)

  const btn = document.getElementById("btn-fix-from-errors")
  if (btn) {
    btn.disabled = true
    btn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
    </svg> Fixing…`
  }

  // Hold the prior successful result verbatim until the bundle replacement
  // generation AND review both succeed; a failure restores it below.
  const previousResult = snapshotGenerationResult()

  try {
    hideReplacementFailure()
    const refinementPrompt = buildBundleRegenerationPrompt({
      bundleSpec: pipelineState.step1Result,
      artifactBundle: JSON.stringify(pipelineState.artifactBundle || pipelineState.step2Result),
      bundleReview: pipelineState.step3Result,
      userFeedback: pastedErrors,
    });

    hideErrorInputPanel()
    showPipelineProgress({ runId })
    updatePipelineProgressStep(2, runId)

    selectWorkflowStep(2)
    showStepLoading(2, true)

    const step2Result = await runCodeGenerator(refinementPrompt, selectedModel, [], runId)
    if (!isCurrentPipelineRun(runId)) return
    pipelineState.step2Result = step2Result
    updateArtifactBundleFromGeneratedCode()
    completePipelineStage(2, runId)

    const step2Output = document.getElementById("step2-output")
    const cleanStep2 = extractCodeFromMarkdown(pipelineState.step2Result)
    step2Output.textContent = cleanStep2
    step2Output.dataset.raw = cleanStep2
    showStepLoading(2, false)

    selectWorkflowStep(3)
    updatePipelineProgressStep(3, runId)
    showStepLoading(3, true)

    const step3Result = await runCodeReview(pipelineState.step2Result, pipelineState.step1Result)
    if (!isCurrentPipelineRun(runId)) return
    pipelineState.step3Result = step3Result
    updateBundleReviewFromReviewResult()
    completePipelineStage(3, runId)

    const auditOutput = document.getElementById("step3-output")
    auditOutput.textContent = pipelineState.step3Result
    showStepLoading(3, false)

    hidePipelineProgress()
    const auditHtml = renderMarkdownAudit(pipelineState.step3Result)
    showResultsView(cleanStep2, auditHtml)

    if (input) input.value = ""
  } catch (error) {
    console.error("Fix from errors failed:", error)
    if (!isCurrentPipelineRun(runId)) return

    const errorStep = resolvePipelineErrorStep(error, {
      architect: 2,
      generator: 2,
      review: 3,
    })

    // Restore the previous successful result and keep it visible and copyable
    // with persistent error + retry UI; the failed replacement never owns the
    // screen.
    restoreAndShowReplacementFailure(error, {
      previous: previousResult,
      stage: errorStep,
      runId,
      retry: regenerateFromPastedErrors,
    })
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = "Fix Errors & Regenerate"
    }
    if (isCurrentPipelineRun(runId)) {
      pipelineState.isRunning = false
      updateDeployButtonVisibility()
    }
  }
}

// --- MAIN PIPELINE ---

async function runThinkingPipeline() {
  console.log("runThinkingPipeline called");

  if (pipelineState.isRunning) return;

  localStorage.setItem("hasSeenWalkthrough", "true");

  const userInput = document.getElementById("pipeline-input").value;
  const selectedModel = document.getElementById("code-generator-model").value;

  if (!userInput.trim()) {
    showToast("Please describe your FlutterFlow widget first.", "warning");
    return;
  }

  // The run is claimed before the first await, so a second submission during
  // preflight sees it already running instead of starting a concurrent run
  // beside it.
  pipelineState.isRunning = true;
  const runId = startPipelineRun();

  try {
    if (!(await canRunPipeline())) return;
    if (!isCurrentPipelineRun(runId)) return;

    await ensureIdentityReady();
    if (!isCurrentPipelineRun(runId)) return;

    const effectiveModel = getEffectiveModel(selectedModel);

    trackEvent("Pipeline Started", { 
      selectedModel, 
      effectiveModel,
      inputLength: userInput.length
    });

    // Reset state
    resetPipelineResults();
    pipelineState.submittedPrompt = userInput;
    pipelineState.submittedImages = promptImages.slice();

    setRunPipelineButtonBusy(true);

    // Update model info
    updateModelInfo(effectiveModel);

    // Dismiss welcome video and hide ready state, show progress
    dismissWelcomeVideo();
    const readyState = document.getElementById("ready-state");
    if (readyState) readyState.classList.add("hidden");
    const paywallEl = document.getElementById("paywall-exhausted");
    if (paywallEl) paywallEl.classList.add("hidden");

    // Show pipeline progress bar. The outline morph runs over the panel once
    // the panel itself is in place, so busy feedback is immediate either way.
    showPipelineProgress({ prompt: userInput, runId });
    morphComposerToPipeline();

    // Step 1: Prompt Architect
    selectWorkflowStep(1);
    updatePipelineProgressStep(1, runId);
    showStepLoading(1, true);

    // Uploaded image URLs are sent to both the architect and the generator so
    // the vision-carrying model sees them when producing the widget.
    const imagePayload = promptImages
      .filter((img) => img.url)
      .map((img) => ({ url: img.url }));

    // A stage result commits to shared pipeline state only after its run is
    // revalidated: a response that lands after the user started a newer run
    // belongs to a run nobody is watching any more, so it must not touch
    // pipeline state or the view.
    const step1Result = await runPromptArchitect(
      userInput,
      imagePayload,
    );
    if (!isCurrentPipelineRun(runId)) return;
    pipelineState.step1Result = step1Result;
    updateBundleSpecFromArchitectResult();
    completePipelineStage(1, runId);
    trackEvent("Prompt Architect Completed");

    const step1Output = document.getElementById("step1-output")
    const cleanStep1 = extractCodeFromMarkdown(pipelineState.step1Result)
    step1Output.textContent = cleanStep1
    step1Output.dataset.raw = cleanStep1
    showStepLoading(1, false)

    // Step 2: Code Generator
    selectWorkflowStep(2);
    updatePipelineProgressStep(2, runId);
    showStepLoading(2, true);

    const step2Result = await runCodeGenerator(
      pipelineState.step1Result,
      effectiveModel,
      imagePayload,
      runId,
    );
    if (!isCurrentPipelineRun(runId)) return;
    pipelineState.step2Result = step2Result;
    updateArtifactBundleFromGeneratedCode();
    completePipelineStage(2, runId);
    trackEvent("Code Generator Completed");

    const step2Output = document.getElementById("step2-output");
    const cleanStep2 = extractCodeFromMarkdown(pipelineState.step2Result);
    step2Output.textContent = cleanStep2;
    step2Output.dataset.raw = cleanStep2; // Store raw for copy
    showStepLoading(2, false);

    // Step 3: Code Audit
    selectWorkflowStep(3);
    updatePipelineProgressStep(3, runId);
    showStepLoading(3, true);

    const step3Result = await runCodeReview(
      pipelineState.step2Result,
      pipelineState.step1Result,
    );
    if (!isCurrentPipelineRun(runId)) return;
    pipelineState.step3Result = step3Result;
    updateBundleReviewFromReviewResult();
    completePipelineStage(3, runId);
    trackEvent("Code Review Completed");

    const auditOutput = document.getElementById("step3-output");
    auditOutput.textContent = pipelineState.step3Result;

    showStepLoading(3, false);

    // Every stage reported, so the Results view is a real outcome: expand the
    // panel into it and hand the outline morph over to the expansion.
    hidePipelineProgress();
    const auditHtml = renderMarkdownAudit(pipelineState.step3Result);
    morphPipelineToResults();
    showResultsView(cleanStep2, auditHtml);
  } catch (error) {
    // A cancelled request belongs to a run the user already abandoned; it is
    // not a failure and the run check below discards it quietly anyway.
    if (!error.isPipelineCancel) console.error("Pipeline failed:", error);
    // A terminated run never renders a result. The failure replaces the
    // in-flight state in the same panel and stays there until the user acts.
    if (!isCurrentPipelineRun(runId)) return;

    const errorStep = resolvePipelineErrorStep(error, {
      architect: 1,
      generator: 2,
      review: 3,
    });

    if (error.isUsageLimit) {
      updateUsageDisplay();
    } else {
      trackEvent("Pipeline Failed", {
        error: error.message,
        effectiveModel: getEffectiveModel(document.getElementById("code-generator-model").value)
      });
    }

    selectWorkflowStep(errorStep);
    showStepLoading(errorStep, false);
    showPipelineFailure(error, { stage: errorStep, runId });
    updateStepIndicator(errorStep, "error");
  } finally {
    if (isCurrentPipelineRun(runId)) {
      pipelineState.isRunning = false;
      setRunPipelineButtonBusy(false);
      updateDeployButtonVisibility();
    }
  }
}

function retryWithDifferentModel() {
  // Show model selection dialog
  const currentModel = document.getElementById("code-generator-model").value;
  const otherModels = [
    FREE_MODEL,
    "anthropic/claude-opus-5",
    "openai/gpt-5.6-sol",
  ].filter((model) => model !== currentModel);

  const selectedModel = prompt(
    `Retry with different model?\n\nCurrent: ${currentModel}\n\nOptions:\n1. ${otherModels[0]}\n2. ${otherModels[1]}\n\nEnter 1 or 2:`,
  );

  if (selectedModel === "1") {
    document.getElementById("code-generator-model").value = otherModels[0];
    runThinkingPipeline();
  } else if (selectedModel === "2") {
    document.getElementById("code-generator-model").value = otherModels[1];
    runThinkingPipeline();
  }
}

/**
 * Initiates the commit to FlutterFlow process from the UI.
 * Called when user clicks the "Commit to FlutterFlow" button.
 */
async function initiateCommitToFlutterFlow() {
  const code = getSelectedArtifactCode();
  if (!code) {
    showToast("No code to commit. Please run the pipeline first.", "warning");
    return;
  }

  const apiKey = await getApiKey("flutterflow");
  const projectId = await getApiKey("flutterflow_project_id");

  if (!apiKey || !projectId) {
    showToast("FlutterFlow credentials not configured. Add your API Key and Project ID in settings.", "warning");
    openApiKeysModal();
    return;
  }

  if (pipelineState.artifactBundle?.artifacts?.length > 1) {
    await initiateBundleCommitToFlutterFlow();
    return;
  }

  const { artifactType, artifactName, fileName } = getCurrentArtifactMetadata();

  const codeInfo = prepareCodeForCommit(code, { artifactType, artifactName, fileName });

  const checks = runPreCommitChecks(codeInfo);

  if (!checks.canProceed) {
    showToast(`Pre-commit checks failed: ${checks.issues.join("; ")}`, "error");
    return;
  }

  // Route through the shared confirm modal so the user picks the target
  // FlutterFlow project right before deploying.
  openCommitConfirmModal(codeInfo, checks, null, null);
}

async function initiateBundleCommitToFlutterFlow() {
  const apiKey = await getApiKey("flutterflow");
  const projectId = await getApiKey("flutterflow_project_id");

  if (!apiKey || !projectId) {
    showToast("FlutterFlow credentials not configured. Add your API Key and Project ID in settings.", "warning");
    openApiKeysModal();
    return;
  }

  const plan = buildBundleDeployPlan(pipelineState.artifactBundle);
  if (plan.errors.length > 0) {
    showToast(`Bundle validation failed: ${plan.errors.join("; ")}`, "error");
    return;
  }
  const fileMap = new Map(
    plan.fileEntries.map((entry) => [
      entry.fileName,
      {
        content: entry.content,
        type: entry.type,
        path: entry.path,
      },
    ]),
  );

  const validation = validateFileMap(fileMap);
  const checks = {
    canProceed: validation.valid && plan.errors.length === 0,
    issues: [...plan.errors, ...validation.errors],
    warnings: [...plan.warnings, ...validation.warnings],
  };
  if (!checks.canProceed) {
    showToast(`Bundle validation failed: ${checks.issues.join("; ")}`, "error");
    return;
  }
  const codeInfo = {
    content: plan.fileEntries.map((entry) => `// ${entry.fileName}\n${entry.content}`).join("\n\n"),
    fileName: `${plan.fileEntries.length} files`,
    codeType: "bundle",
    artifactType: "Bundle",
    artifactName: plan.title,
  };

  openCommitConfirmModal(codeInfo, checks, plan.dependencies, plan);
}

/**
 * Shows commit errors in the UI with option to regenerate
 */
function showCommitError(result) {
  // Parse error map from result
  let errorMap = result.errorMap || new Map();

  // If errorMap is not a Map, try to convert it
  if (!(errorMap instanceof Map) && typeof errorMap === "object") {
    errorMap = new Map(Object.entries(errorMap));
  }

  // Format error message
  let errorHtml = `<div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
    <h4 class="text-red-600 font-bold text-sm uppercase mb-2">FlutterFlow Commit Failed</h4>
    <p class="text-sm text-red-700 mb-3">${escapeHtml(result.error)}</p>`;

  if (errorMap && errorMap.size > 0) {
    errorHtml += `<div class="mt-3">
      <p class="text-xs font-semibold text-red-600 uppercase mb-2">Errors:</p>
      <ul class="text-sm text-red-700 space-y-2">`;

    for (const [fileName, errorInfo] of errorMap.entries()) {
      const message = formatFlutterFlowFileError(errorInfo);
      errorHtml += `<li class="bg-white p-2 rounded border border-red-100">
        <strong class="text-red-800">${escapeHtml(fileName)}:</strong> ${escapeHtml(message)}
      </li>`;
    }

    errorHtml += `</ul></div>`;
  }

  errorHtml += `</div>`;

  // Add regenerate button
  errorHtml += `<div class="flex gap-3 mt-4">
    <button id="btn-regenerate-from-error" class="btn-primary bg-indigo-600 hover:bg-indigo-700">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
      </svg>
      Fix Errors & Regenerate
    </button>
  </div>`;

  // Display in step 3 output
  const step3Output = document.getElementById("step3-output");
  if (step3Output) {
    step3Output.innerHTML = errorHtml;

    // Add click handler for regenerate button
    document
      .getElementById("btn-regenerate-from-error")
      ?.addEventListener("click", () => {
        regenerateWithErrors(result.error, errorMap);
      });
  }
}

/**
 * Regenerates code with FlutterFlow errors included in the prompt
 */
async function regenerateWithErrors(originalError, errorMap) {
  if (pipelineState.isRunning) return;

  const selectedModel = document.getElementById("code-generator-model").value;

  pipelineState.isRunning = true;
  const runId = startPipelineRun();

  const btn = document.getElementById("btn-regenerate-from-error");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
    </svg> Fixing...`;
  }

  try {
    // Build error context for regeneration
    let errorContext =
      "The previous code had the following errors when committing to FlutterFlow:\n\n";

    if (errorMap && errorMap.size > 0) {
      for (const [fileName, errorInfo] of errorMap.entries()) {
        const message = formatFlutterFlowFileError(errorInfo);
        errorContext += `File: ${fileName}\nError: ${message}\n\n`;
      }
    } else {
      errorContext += `${originalError}\n`;
    }

    const refinementPrompt = buildBundleRegenerationPrompt({
      bundleSpec: pipelineState.step1Result,
      artifactBundle: JSON.stringify(pipelineState.artifactBundle || pipelineState.step2Result),
      bundleReview: pipelineState.step3Result,
      userFeedback: errorContext,
    });

    showPipelineProgress({ runId });
    updatePipelineProgressStep(2, runId);

    // Go to step 2
    selectWorkflowStep(2);
    showStepLoading(2, true);

    // Generate new code. Stage results commit to shared state only after the
    // run is revalidated, so an abandoned run cannot overwrite a newer one.
    const step2Result = await runCodeGenerator(
      refinementPrompt,
      selectedModel,
      [],
      runId,
    );
    if (!isCurrentPipelineRun(runId)) return;
    pipelineState.step2Result = step2Result;
    updateArtifactBundleFromGeneratedCode();
    completePipelineStage(2, runId);

    const step2Output = document.getElementById("step2-output");
    const cleanStep2 = extractCodeFromMarkdown(pipelineState.step2Result);
    step2Output.textContent = cleanStep2;
    step2Output.dataset.raw = cleanStep2;
    showStepLoading(2, false);

    // Run audit
    selectWorkflowStep(3);
    updatePipelineProgressStep(3, runId);
    showStepLoading(3, true);

    const step3Result = await runCodeReview(
      pipelineState.step2Result,
      pipelineState.step1Result,
    );
    if (!isCurrentPipelineRun(runId)) return;
    pipelineState.step3Result = step3Result;
    updateBundleReviewFromReviewResult();
    completePipelineStage(3, runId);

    const auditOutput = document.getElementById("step3-output");
    auditOutput.textContent = pipelineState.step3Result;

    showStepLoading(3, false);

    hidePipelineProgress();
    const auditHtml = renderMarkdownAudit(pipelineState.step3Result);
    showResultsView(cleanStep2, auditHtml);
  } catch (error) {
    console.error("Regeneration failed:", error);
    if (!isCurrentPipelineRun(runId)) return;

    const errorStep = resolvePipelineErrorStep(error, {
      architect: 2,
      generator: 2,
      review: 3,
    });

    if (error.isUsageLimit) {
      updateUsageDisplay();
    }

    selectWorkflowStep(errorStep);
    showStepLoading(errorStep, false);
    showPipelineFailure(error, {
      stage: errorStep,
      runId,
      retry: () => regenerateWithErrors(originalError, errorMap),
    });
    updateStepIndicator(errorStep, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Fix Errors & Regenerate";
    }
    if (isCurrentPipelineRun(runId)) {
      pipelineState.isRunning = false;
      updateDeployButtonVisibility();
    }
  }
}


/**
 * Updates the FlutterFlow credential status indicator in Step 3.
 */
async function updateFlutterFlowCredentialStatus() {
  const statusDot = document.getElementById("ff-status-dot");
  const statusText = document.getElementById("ff-status-text");

  if (!statusDot || !statusText) return;

  const apiKey = await getApiKey("flutterflow");
  const projectId = await getApiKey("flutterflow_project_id");

  if (apiKey && projectId) {
    statusDot.className = "w-2 h-2 rounded-full bg-green-500";
    statusText.textContent = "FlutterFlow credentials configured";
    statusText.className = "text-green-600";
  } else if (apiKey || projectId) {
    statusDot.className = "w-2 h-2 rounded-full bg-yellow-500";
    statusText.textContent = "FlutterFlow credentials incomplete";
    statusText.className = "text-yellow-600";
  } else {
    statusDot.className = "w-2 h-2 rounded-full bg-red-500";
    statusText.textContent = "FlutterFlow credentials not configured";
    statusText.className = "text-red-600";
  }
}

// --- SYNTAX HIGHLIGHTING ---

// Extract code from markdown code blocks (strips ```dart ... ```)
// --- AUTH FUNCTIONS ---

async function sendMagicLink(email) {
  try {
    const res = await fetch(`${BUILDSHIP_BASE_URL}/auth/send-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    })
    if (!res.ok) throw new Error(`Failed to send magic link: HTTP ${res.status}`)
    return res.json()
  } catch (err) {
    console.error('sendMagicLink failed:', { email, message: err.message, stack: err.stack })
    throw err
  }
}

async function verifyMagicLink(token) {
  try {
    const res = await fetch(`${BUILDSHIP_BASE_URL}/auth/verify-magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    })
    const data = await res.json()
    if (data.error || !data.email || !data.sessionToken) {
      throw new Error(data.error || 'Invalid or expired link')
    }
    return data
  } catch (err) {
    console.error('verifyMagicLink failed:', { message: err.message, stack: err.stack })
    throw err
  }
}

async function refreshSession(sessionToken) {
  try {
    const res = await fetch(`${BUILDSHIP_BASE_URL}/auth/refresh-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken })
    })
    if (!res.ok) {
      console.error('refreshSession: non-OK response', { url: `${BUILDSHIP_BASE_URL}/auth/refresh-session`, status: res.status })
      return null
    }
    const data = await res.json()
    if (data.error || !data.email || !data.sessionToken) {
      console.warn('refreshSession: validation failed', { error: data.error, hasEmail: !!data.email, hasToken: !!data.sessionToken })
      return null
    }
    return data
  } catch (err) {
    console.error('refreshSession: fetch failed', { url: `${BUILDSHIP_BASE_URL}/auth/refresh-session`, message: err.message, stack: err.stack })
    return null
  }
}

function saveSession(email, sessionToken) {
  const storedSession = getStoredSession()
  const sessionChanged = (authState.email || storedSession.email) !== email
  authState.email = email
  authState.sessionToken = sessionToken
  authState.isVerified = true
  subscriptionState = createSubscriptionState({ isLoading: true })
  localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify({ email, sessionToken }))
  if (sessionChanged) clearSubscriptionCache()
}

function clearSession() {
  authState.email = null
  authState.sessionToken = null
  authState.isVerified = false
  subscriptionState = createSubscriptionState({ isResolved: true })
  localStorage.removeItem(AUTH_SESSION_STORAGE_KEY)
  localStorage.removeItem(SUBSCRIPTION_CACHE_KEY)
}

function getStoredSession() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_STORAGE_KEY)
    if (!raw) return { email: null, sessionToken: null }
    const session = JSON.parse(raw)
    if (!session.email || !session.sessionToken) return { email: null, sessionToken: null }
    return session
  } catch (err) {
    console.warn('getStoredSession: failed to parse auth session:', err)
    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY)
    return { email: null, sessionToken: null }
  }
}

async function initializeAuth() {
  const params = new URLSearchParams(window.location.search)
  const magicToken = params.get('token')

  if (magicToken) {
    window.history.replaceState({}, '', window.location.pathname + window.location.hash)
    try {
      const { email, sessionToken } = await verifyMagicLink(magicToken)
      saveSession(email, sessionToken)
      closeSignInModal()
      // Land back on whichever surface (composer, plans, billing) the user
      // asked to sign in from, unless the link itself already carried a hash.
      const returnHash = consumeSignInReturnSurface()
      if (returnHash && !window.location.hash) window.location.hash = returnHash
    } catch (err) {
      consumeSignInReturnSurface()
      const message = err.message || 'Sign-in link invalid or expired.'
      showToast(message, 'error')
      // Surface the failure inline too, with the retry control right there,
      // instead of leaving the user to hunt for a way back in.
      openSignInModal()
      setSignInMessage(message, 'error')
    }
  } else {
    const { email, sessionToken } = getStoredSession()
    if (email && sessionToken) {
      const refreshed = await refreshSession(sessionToken)
      if (refreshed) {
        saveSession(refreshed.email, refreshed.sessionToken)
      } else {
        clearSession()
      }
    }
  }

  updateAuthUI()
}

// Records which surface (home/composer, plans, or account/billing) the user
// was on when they opened the sign-in modal, so a magic-link click — which
// lands as a fresh page load — can return them there. Keyed by URL hash,
// which is how switchView() already tracks the current surface.
function rememberSignInReturnSurface() {
  try {
    localStorage.setItem(SIGNIN_RETURN_STORAGE_KEY, JSON.stringify({
      hash: window.location.hash || '#home',
      ts: Date.now(),
    }))
  } catch (err) {
    console.warn('rememberSignInReturnSurface: failed to persist return surface:', err)
  }
}

function consumeSignInReturnSurface() {
  try {
    const raw = localStorage.getItem(SIGNIN_RETURN_STORAGE_KEY)
    localStorage.removeItem(SIGNIN_RETURN_STORAGE_KEY)
    if (!raw) return null
    const { hash, ts } = JSON.parse(raw)
    if (!hash || typeof ts !== 'number' || Date.now() - ts > SIGNIN_RETURN_TTL_MS) return null
    return hash
  } catch (err) {
    console.warn('consumeSignInReturnSurface: failed to read return surface:', err)
    return null
  }
}

function openSignInModal() {
  const modal = document.getElementById('signin-modal')
  if (!modal) return
  rememberSignInReturnSurface()
  const input = document.getElementById('signin-email-input')
  input?.removeAttribute('aria-invalid')
  setSignInMessage('')
  openModal(modal)
}

function closeSignInModal(event) {
  if (event && event.target !== event.currentTarget) return
  const modal = document.getElementById('signin-modal')
  if (modal) closeModal(modal)
}

function setSignInMessage(text, variant) {
  const msg = document.getElementById('signin-message')
  if (!msg) return
  msg.textContent = text || ''
  msg.classList.remove('signin-message-success', 'signin-message-error')
  if (variant) msg.classList.add(`signin-message-${variant}`)
}

async function handleMagicLinkRequest() {
  const input = document.getElementById('signin-email-input')
  const btn = document.getElementById('signin-submit-btn')
  const email = trimEmail(input?.value)

  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  if (!email || !emailRegex.test(email) || email.length > 254) {
    input?.setAttribute('aria-invalid', 'true')
    setSignInMessage('Please enter a valid email address.', 'error')
    return
  }
  input?.removeAttribute('aria-invalid')

  if (btn) { btn.disabled = true; btn.textContent = 'Sending…' }

  // Explain the rule for known providers, but do not block submission here.
  // Existing accounts on plus-tagged addresses are still allowed to recover
  // because the server performs the authoritative check.
  const plusAliasHint = explainPlusAliasRule(email)
  if (plusAliasHint) setSignInMessage(plusAliasHint, 'error')

  try {
    const data = await sendMagicLink(email)
    const isAliasRejected = data?.code === PLUS_ALIAS_REJECTED_CODE
    if (input && !isAliasRejected) input.value = ''
    input?.setAttribute('aria-invalid', String(isAliasRejected))
    setSignInMessage(getMagicLinkResultMessage(data, email), isAliasRejected ? 'error' : 'success')
    // A successful send must stay retryable — the user may want to resend to
    // a different address, or send another link if the first one expires —
    // so the button is re-enabled either way, never left permanently disabled.
    // "Sent!" is shown briefly for confirmation, then reverts so the control
    // clearly reads as usable again.
    if (btn) {
      btn.disabled = false
      btn.textContent = isAliasRejected ? 'Send Sign-in Link' : 'Sent!'
      if (!isAliasRejected) {
        setTimeout(() => { if (btn.textContent === 'Sent!') btn.textContent = 'Send Sign-in Link' }, 2500)
      }
    }
  } catch (err) {
    console.error('handleMagicLinkRequest: sendMagicLink failed', { email, err })
    setSignInMessage('Something went wrong. Please try again.', 'error')
    if (btn) { btn.disabled = false; btn.textContent = 'Send Sign-in Link' }
  }
}

function handleSignOut() {
  clearSession()
  clearSubscriptionCache()
  updateAuthUI()
  updateSubscriptionUI()
}

function updateAuthUI() {
  const signedIn = authState.isVerified && !!authState.email
  const signedout = document.getElementById('auth-signedout')
  const signedin = document.getElementById('auth-signedin')
  const guestUsage = document.getElementById('auth-guest-usage')
  if (signedout) signedout.classList.toggle('hidden', signedIn)
  if (signedin) signedin.classList.toggle('hidden', !signedIn)
  if (guestUsage) guestUsage.classList.toggle('hidden', signedIn)
  const emailEl = document.getElementById('auth-user-email')
  if (emailEl) emailEl.textContent = authState.email || ''
  updateGuestUsageCounter()
  updateSubscriptionUI()
}

function getOrCreateCookieId() {
  let cookieId = localStorage.getItem(IDENTITY_COOKIE_KEY)
  if (!cookieId) {
    cookieId = crypto.randomUUID()
    localStorage.setItem(IDENTITY_COOKIE_KEY, cookieId)
  }
  return cookieId
}

async function resolveIdentity() {
  try {
    if (typeof FingerprintJS === 'undefined') {
      console.warn('resolveIdentity: FingerprintJS not loaded, skipping')
      return
    }

    const fp = await FingerprintJS.load()
    const result = await fp.get()
    const cookieId = result.visitorId

    const response = await fetch(IDENTITY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: result.visitorId, cookie_id: cookieId }),
    })

    if (!response.ok) {
      throw new Error(`Identity check HTTP ${response.status}`)
    }

    const data = await response.json()
    identityState.userId = data.user_id
    identityState.token = data.identity_token || null
    identityState.status = data.status
    identityState.resolved = true
    sessionStorage.setItem(IDENTITY_SESSION_KEY, data.user_id)
    if (identityState.token) {
      sessionStorage.setItem(IDENTITY_TOKEN_KEY, identityState.token)
    }

    if (data.usage_count !== undefined) {
      const currentMonth = getCurrentYearMonth()
      const serverMonth = data.usage_month || currentMonth
      const serverCount = serverMonth === currentMonth ? data.usage_count : 0
      localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify({ count: serverCount, month: currentMonth }))
      updateUsageDisplay()
    }

    console.log(`Identity resolved: ${data.status} (${data.user_id.slice(0, 8)}...) usage: ${data.usage_count ?? 'n/a'}`)
  } catch (error) {
    console.error('resolveIdentity failed:', error)
  }
}

let identityResolvePromise = null

function ensureIdentityReady(maxWaitMs = 5000) {
  if (identityState.resolved) return Promise.resolve()
  if (!identityResolvePromise) {
    identityResolvePromise = resolveIdentity().catch((err) => {
      console.warn('ensureIdentityReady: identity resolution failed', err)
    })
  }
  return Promise.race([
    identityResolvePromise,
    new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
  ])
}

// --- USAGE METERING ---

function getUsageData() {
  const month = getCurrentYearMonth()
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY)
    if (!raw) return { count: 0, month }
    return JSON.parse(raw)
  } catch (err) {
    console.warn('getUsageData: failed to parse usage storage', { key: USAGE_STORAGE_KEY, month, err })
    localStorage.removeItem(USAGE_STORAGE_KEY)
    return { count: 0, month }
  }
}

function getCurrentYearMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getUsage() {
  const data = getUsageData()
  if (data.month !== getCurrentYearMonth()) {
    return { count: 0, month: getCurrentYearMonth() }
  }
  return data
}

function incrementUsage() {
  const current = getUsage()
  const updated = { count: current.count + 1, month: getCurrentYearMonth() }
  localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(updated))
  return updated
}

function isSubscriptionLoading() {
  return !!subscriptionState.isLoading
}

function isSubscriptionResolved() {
  return !!subscriptionState.isResolved
}

function normalizeTier(value) {
  if (!value) return null
  const tier = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_')
  if (tier === 'pro' || tier === 'professional_plan') return 'professional'
  if (tier === 'power_developer' || tier === 'power_plan') return 'power'
  if (Object.prototype.hasOwnProperty.call(TIER_LIMITS, tier)) return tier
  return null
}

function tierFromPriceId(priceId) {
  if (!priceId) return null
  return Object.entries(STRIPE_PRICE_IDS).find(([, id]) => id === priceId)?.[0] || null
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

function firstSubscriptionLike(...values) {
  return values.find(value => value && typeof value === 'object') || {}
}

function normalizeSubscriptionResponse(data) {
  const response = data.data && typeof data.data === 'object' ? data.data : data
  const subscription = firstSubscriptionLike(
    response.subscription,
    response.stripeSubscription,
    response.currentSubscription,
    response.customer?.subscriptions?.data?.[0],
    response.subscriptions?.data?.[0],
    response.subscriptions?.[0],
  )
  const metadata = response.metadata || subscription.metadata || response.customer?.metadata || {}
  const priceId = firstValue(
    response.priceId,
    response.price_id,
    response.stripePriceId,
    response.stripe_price_id,
    subscription.priceId,
    subscription.price_id,
    subscription.plan?.id,
    subscription.price?.id,
    subscription.items?.data?.[0]?.price?.id,
    subscription.items?.[0]?.price?.id,
    subscription.lines?.data?.[0]?.price?.id,
  )
  const status = firstValue(response.status, response.subscriptionStatus, response.subscription_status, subscription.status, 'none')
  const explicitTier = normalizeTier(firstValue(
    response.tier,
    response.plan,
    response.planId,
    response.plan_id,
    response.subscriptionTier,
    response.subscription_tier,
    response.product,
    response.productName,
    subscription.tier,
    subscription.plan,
    metadata.tier,
    metadata.plan,
  ))
  const paidByStatus = PAID_SUBSCRIPTION_STATUSES.has(String(status).toLowerCase())
  const paidByFlag = response.active === true || response.isSubscribed === true || response.subscribed === true || response.hasSubscription === true
  const tier = explicitTier || tierFromPriceId(priceId) || ((paidByStatus || paidByFlag) ? 'professional' : 'free')

  return createSubscriptionState({
    tier,
    status,
    periodEnd: firstValue(response.periodEnd, response.currentPeriodEnd, response.current_period_end, subscription.current_period_end, subscription.periodEnd, null),
    isResolved: true,
  })
}

function getRunLimit() {
  return TIER_LIMITS[subscriptionState.tier] ?? TIER_LIMITS.free
}

async function canRunPipeline() {
  if (authState.isVerified && (!isSubscriptionResolved() || isSubscriptionLoading())) {
    await fetchSubscription({ force: true })
    updateSubscriptionUI()
  }

  if (authState.isVerified && !isSubscriptionResolved()) {
    showToast('Could not verify your subscription. Please refresh or try Manage billing.', 'error')
    return false
  }

  const { count } = getUsage()
  const limit = getRunLimit()
  if (count >= limit) {
    showPaywallExhausted(count, limit, { openModal: true })
    return false
  }
  const warningThreshold = Math.floor(limit * 0.8)
  if (count >= warningThreshold) {
    const remaining = limit - count
    showToast(`${remaining} run${remaining === 1 ? '' : 's'} remaining this month.`, 'warning')
  }
  return true
}

function hidePaywallExhausted() {
  const paywall = document.getElementById('paywall-exhausted')
  if (paywall) paywall.classList.add('hidden')
}

function showPaywallExhausted(count, limit, options = {}) {
  setGenerationStageVisible(true);
  const walkthroughModal = document.getElementById('walkthrough-modal')
  if (walkthroughModal) closeModal(walkthroughModal, { restoreFocus: false })

  const readyState = document.getElementById('ready-state')
  if (readyState) readyState.classList.add('hidden')

  const previewContainer = document.getElementById('preview-frame-container')
  if (previewContainer) previewContainer.style.display = 'none'

  const stageContainer = document.getElementById('main-stage-container')
  if (stageContainer) stageContainer.classList.add('visible')

  const resultsView = document.getElementById('results-view')
  if (resultsView) resultsView.classList.remove('visible')
  document.body.classList.remove("results-fullscreen", "results-with-sidebar")

  const pipelineProgress = document.getElementById('pipeline-progress')
  if (pipelineProgress) pipelineProgress.classList.remove('visible')

  const paywall = document.getElementById('paywall-exhausted')
  if (!paywall) {
    showToast(`You've used all ${limit} runs for this month. Upgrade to continue.`, 'error')
    openPricingModal()
    return
  }

  const textEl = document.getElementById('paywall-exhausted-text')
  if (textEl) {
    const tier = subscriptionState.tier
    if (tier === 'free') {
      textEl.textContent = `You've used all ${limit} free generations this month. Upgrade to Pro for 50 generations/month and access to all AI models.`
    } else {
      textEl.textContent = `You've used all ${limit} generations this month on your ${tier} plan. Your limit resets next month.`
    }
  }

  const signInBtn = document.getElementById('paywall-signin-btn')
  if (signInBtn) signInBtn.classList.toggle('hidden', authState.isVerified)

  paywall.classList.remove('hidden')
  if (options.openModal) openPricingModal()
}

function getEffectiveModel(selectedModel) {
  const tier = subscriptionState.tier
  if (tier === 'free' && PRO_MODELS.includes(selectedModel)) {
    return FREE_MODEL
  }
  return selectedModel
}

function updateModelSelectorGating() {
  const container = document.getElementById('code-options-content')
  const select = document.getElementById('code-generator-model')
  if (!container || !select) return

  const tier = subscriptionState.tier
  const unresolvedSignedIn = authState.isVerified && !isSubscriptionResolved()
  const isFree = !unresolvedSignedIn && tier === 'free'

  Array.from(select.options).forEach(opt => {
    const baseLabel = getModelLabel(opt.value)
    const isPro = PRO_MODELS.includes(opt.value)
    opt.textContent = isPro && isFree ? `${baseLabel} (PRO)` : baseLabel
    opt.disabled = false
  })

  if (isFree && PRO_MODELS.includes(select.value)) {
    select.value = FREE_MODEL
  }

  select.disabled = false

  // Intercept PRO model selection on free tier → open pricing modal
  if (!proGateAttachedSet.has(select)) {
    select.addEventListener('change', () => {
      if (isSubscriptionResolved() && subscriptionState.tier === 'free' && PRO_MODELS.includes(select.value)) {
        select.value = FREE_MODEL
        openPricingModal()
      }
      updateModelInfo(select.value)
      updatePromptImageAvailability()
    })
    proGateAttachedSet.add(select)
  }

  let notice = document.getElementById('model-selector-free-notice')
  if (isFree) {
    if (!notice) {
      notice = document.createElement('p')
      notice.id = 'model-selector-free-notice'
      notice.className = 'text-xs text-gray-400 mt-1'
      container.appendChild(notice)
    }
    notice.innerHTML = `Free plan — Gemini only. <button onclick="openPricingModal()" style="color:#3b82f6;background:none;border:none;cursor:pointer;font:inherit;padding:0;text-decoration:underline;">Upgrade for all models</button>`
  } else if (notice) {
    notice.remove()
  }

  updateModelInfo(select.value)
}

/**
 * Single source of truth for the monthly-usage presentation shown in the
 * topbar allowance and the usage/billing dialog. Reads the metered count, the
 * resolved tier limit and the auth/subscription state, then writes every usage
 * surface (topbar, dialog, account row, guest counter) consistently. Remaining
 * runs are clamped to zero and an unresolved plan never surfaces a fake balance.
 */
function renderUsageSurfaces() {
  const signedIn = authState.isVerified && !!authState.email;
  const loading = signedIn && isSubscriptionLoading();
  const resolved = !signedIn || isSubscriptionResolved();

  const usage = getUsage();
  const count = resolved ? usage.count : 0;
  const limit = resolved ? getRunLimit() : 0;
  const remaining = Math.max(0, limit - count);
  const usedLimitText = `${count} / ${limit} runs this month`;
  const labels = planLabels;
  const tier = resolved ? (subscriptionState.tier || "free") : null;

  const topbarCredits = document.getElementById("topbar-credits-count");
  if (topbarCredits) {
    if (loading) topbarCredits.textContent = "…";
    else if (!resolved) topbarCredits.textContent = "—";
    else topbarCredits.textContent = String(remaining);
  }

  const balance = document.getElementById("credits-balance");
  if (balance) {
    if (loading) balance.textContent = "Checking plan…";
    else if (!resolved) balance.textContent = "Plan check failed";
    else balance.textContent = usedLimitText;
  }

  const dialogTier = document.getElementById("usage-dialog-tier");
  if (dialogTier) {
    if (loading) dialogTier.textContent = "Checking…";
    else if (!resolved) dialogTier.textContent = "Unavailable";
    else dialogTier.textContent = labels[tier] || "Free";
  }

  const dialogStatus = document.getElementById("usage-dialog-status");
  if (dialogStatus) {
    if (loading) dialogStatus.textContent = "Verifying your subscription…";
    else if (!resolved) dialogStatus.textContent = "Could not verify your subscription. Try again or sign out.";
    else dialogStatus.textContent = "Runs reset at the start of each month.";
  }

  const counter = document.getElementById("usage-counter");
  if (counter) {
    if (loading && signedIn) {
      counter.textContent = "Checking plan…";
      counter.className = "text-xs text-gray-500";
    } else if (!resolved && signedIn) {
      counter.textContent = "Plan check failed";
      counter.className = "text-xs text-red-600 font-medium";
    } else {
      counter.textContent = usedLimitText;
      const pct = limit > 0 ? count / limit : 0;
      counter.className = pct >= 1
        ? "text-xs text-red-600 font-medium"
        : pct >= 0.8
          ? "text-xs text-yellow-600 font-medium"
          : "text-xs text-gray-500";
    }
  }

  if (!signedIn) {
    const guestEl = document.getElementById("guest-usage-text");
    if (guestEl) {
      const g = getUsageData();
      const gCount = g.month === getCurrentYearMonth() ? (g.count ?? 0) : 0;
      guestEl.textContent = `${gCount} / ${TIER_LIMITS.free} generations used`;
    }
  }

  renderAccountOverview();
}

/**
 * Renders the account overview: identity, plan, usage meter and available
 * period information. This is the single presentation adapter for the account
 * view and reads the same session, subscription and metered state as the
 * topbar (renderUsageSurfaces), so sign-in/out and a usage refresh move all
 * surfaces together.
 *
 * Honesty contract, enforced by render: every number/date/identity traces to a
 * real field or a documented derivation (email-derived display name/avatar
 * initial, metered count, tier limit). A renewal/reset date is shown ONLY when
 * subscriptionState.periodEnd is a real value — never fabricated — and an
 * unresolved plan surfaces checking/unavailable copy, never a stale balance.
 */
function renderAccountOverview() {
  const signedIn = authState.isVerified && !!authState.email;
  if (!signedIn) {
    // Signed-out/guest state has its own container; leave the signed-in
    // overview untouched in the hidden subtree so no previous identity lingers
    // anywhere a later sign-in could briefly flash it.
    return;
  }

  const loading = isSubscriptionLoading();
  const resolved = isSubscriptionResolved();
  const usage = getUsage();
  const count = resolved ? usage.count : 0;
  const limit = resolved ? getRunLimit() : 0;
  const remaining = Math.max(0, limit - count);
  const tier = resolved ? (subscriptionState.tier || "free") : null;
  const tierLabel = { free: "Free", professional: "Pro", power: "Power" }[tier] || "Free";

  // --- identity: real email, documented derivations only, no member-since ---
  const email = authState.email || "";
  const localPart = email.split("@")[0] || email;
  const avatar = document.getElementById("acct-avatar");
  if (avatar) avatar.textContent = (email[0] || "?").toUpperCase();
  const name = document.getElementById("acct-name");
  if (name) name.textContent = localPart || "—";

  // --- plan ---
  const planTier = document.getElementById("acct-plan-tier");
  const planPrice = document.getElementById("acct-plan-price");
  const planNote = document.getElementById("acct-plan-note");
  const renewal = document.getElementById("acct-renewal");
  if (planTier) {
    planTier.textContent = loading ? "Checking…" : resolved ? tierLabel : "Plan unavailable";
  }
  if (planPrice) {
    if (loading) planPrice.textContent = "—";
    else if (!resolved) planPrice.textContent = "—";
    else if (tier === "free") planPrice.textContent = "$0 / month";
    else {
      const money = formatPrice(BASE_PRICES_AUD[tier] ?? 0, detectUserCurrency());
      planPrice.textContent = `${money} / month`;
    }
  }
  if (planNote) {
    if (loading) planNote.textContent = "Verifying your subscription…";
    else if (!resolved) planNote.textContent = "Could not verify your subscription. Check billing or sign out.";
    else if (tier === "free") planNote.textContent = "No subscription. Upgrade for more generations.";
    else planNote.textContent = "billed monthly through Stripe";
  }
  if (renewal) {
    const periodEndMs = Date.parse(subscriptionState.periodEnd || "");
    const hasRealPeriodEnd = resolved && tier !== "free" && !!subscriptionState.periodEnd && !Number.isNaN(periodEndMs);
    if (loading) renewal.textContent = "";
    else if (!resolved) renewal.textContent = "";
    else if (tier === "free") renewal.textContent = "";
    else if (hasRealPeriodEnd) {
      const date = new Date(periodEndMs).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
      renewal.textContent = `Renews ${date} · reset at the start of each month.`;
    } else {
      // No fabricated date: if the plan has no real period end we say so plainly.
      renewal.textContent = "Renewal date is not available for this period.";
    }
  }

  // --- usage: generations left + meter ---
  const leftCount = document.getElementById("acct-left-count");
  const leftLimit = document.getElementById("acct-left-limit");
  const resetNote = document.getElementById("acct-reset-note");
  if (leftCount) leftCount.textContent = loading ? "…" : !resolved ? "—" : String(remaining);
  if (leftLimit) leftLimit.textContent = loading ? "…" : !resolved ? "—" : String(limit);
  if (resetNote) {
    if (loading) resetNote.textContent = "Checking plan…";
    else if (!resolved) resetNote.textContent = "Plan check failed. Refresh or manage billing.";
    else resetNote.textContent = "Runs reset at the start of each month.";
  }

  const usedCount = document.getElementById("acct-used-count");
  const meterFill = document.getElementById("acct-meter-fill");
  const meterMeta = document.getElementById("acct-meter-meta");
  const meterTrack = document.getElementById("acct-meter-track");
  if (usedCount) usedCount.textContent = loading ? "…" : !resolved ? "—" : String(count);
  if (meterFill) {
    const pct = resolved && limit > 0 ? Math.min(100, Math.round((count / limit) * 100)) : 0;
    meterFill.style.width = `${pct}%`;
  }
  if (meterMeta) {
    if (loading) meterMeta.textContent = "Checking…";
    else if (!resolved) meterMeta.textContent = "Plan check failed";
    else if (limit === 0) meterMeta.textContent = `${count} of ${limit}`;
    else {
      const pct = Math.round((count / limit) * 100);
      meterMeta.textContent = `${count} of ${limit} · ${pct}%`;
    }
  }
  if (meterTrack) {
    if (loading) meterTrack.setAttribute("aria-label", "Checking usage…");
    else if (!resolved) meterTrack.setAttribute("aria-label", "Usage unavailable");
    else meterTrack.setAttribute("aria-label", `${count} of ${limit} generations used`);
  }

  // --- FlutterFlow connection (real stored credential state) ---
  const connKeyConfigured = hasStoredKey("flutterflow");
  const connProjectConfigured = hasStoredKey("flutterflow_project_id");
  const ffDot = document.getElementById("acct-ff-dot");
  const ffStatus = document.getElementById("acct-ff-status");
  const ffEndpoint = document.getElementById("acct-ff-endpoint");
  const ffProject = document.getElementById("acct-ff-project");
  if (ffStatus) {
    if (connKeyConfigured && connProjectConfigured) {
      ffStatus.textContent = "Connected to FlutterFlow";
      if (ffDot) { ffDot.className = "acct-dot ok"; }
    } else if (connKeyConfigured) {
      ffStatus.textContent = "API key set — pick a project";
      if (ffDot) { ffDot.className = "acct-dot warn"; }
    } else {
      ffStatus.textContent = "Not connected — add your FlutterFlow API key";
      if (ffDot) { ffDot.className = "acct-dot"; }
    }
  }
  if (ffEndpoint) {
    const endpoint = getFlutterFlowEndpoint();
    ffEndpoint.textContent = endpoint && endpoint.includes("staging") ? "Staging" : "Production";
  }
  if (ffProject) ffProject.textContent = flutterflowProjectId || "—";
}

function updateUsageDisplay() {
  renderUsageSurfaces()

  if (authState.isVerified && (isSubscriptionLoading() || !isSubscriptionResolved())) {
    hidePaywallExhausted()
    return
  }

  const { count } = getUsage()
  const limit = getRunLimit()
  if (count >= limit && !pipelineState.isRunning) {
    showPaywallExhausted(count, limit)
  } else {
    hidePaywallExhausted()
  }
}

function updateGuestUsageCounter() {
  renderUsageSurfaces()
}

// --- STRIPE FUNCTIONS ---

async function fetchSubscription(options = {}) {
  const force = options.force === true

  if (!authState.isVerified || !authState.sessionToken) {
    subscriptionState = createSubscriptionState({ isResolved: true })
    return
  }

  subscriptionState = { ...subscriptionState, isLoading: true, error: null }

  const cached = localStorage.getItem(SUBSCRIPTION_CACHE_KEY)
  if (!force && cached) {
    try {
      const { data, email, ts, version } = JSON.parse(cached)
      const cacheMatchesSession = version === SUBSCRIPTION_CACHE_VERSION && email === authState.email
      if (cacheMatchesSession && Date.now() - ts < 5 * 60 * 1000) {
        subscriptionState = { ...data, isLoading: false, isResolved: data.isResolved !== false }
        return
      }
    } catch (err) {
      console.warn('Failed to parse subscription cache:', err, '| raw value:', cached)
    }
  }

  try {
    const res = await fetch(`${BUILDSHIP_BASE_URL}/stripe/get-subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: authState.sessionToken, user_id: identityState.userId })
    })

    const data = await res.json()

    if (data.error) {
      const isAuthError = ['unauthorized', 'invalid session', 'expired session'].some(message => String(data.error).toLowerCase().includes(message))
      if (isAuthError) {
        clearSession()
        updateAuthUI()
        return
      }
      subscriptionState = createSubscriptionState({ isResolved: false, error: data.error })
      return
    }
    subscriptionState = normalizeSubscriptionResponse(data)

    localStorage.setItem(SUBSCRIPTION_CACHE_KEY, JSON.stringify({
      version: SUBSCRIPTION_CACHE_VERSION,
      data: subscriptionState,
      email: authState.email,
      ts: Date.now()
    }))
  } catch (err) {
    console.error('fetchSubscription failed:', err)
    subscriptionState = { ...subscriptionState, isLoading: false, isResolved: false, error: err.message }
  }
}

function clearSubscriptionCache() {
  localStorage.removeItem(SUBSCRIPTION_CACHE_KEY)
}

async function startCheckout(tierId) {
  if (!authState.isVerified || !authState.sessionToken) {
    closePricingModal()
    openSignInModal()
    return
  }

  if (!STRIPE_PRICE_IDS[tierId]) {
    showToast('Invalid plan selected.', 'error')
    return
  }

  const btn = document.getElementById(`checkout-btn-${tierId}`)
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…' }

  try {
    const res = await fetch(`${BUILDSHIP_BASE_URL}/stripe/create-checkout-session-intl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId, sessionToken: authState.sessionToken, currency: detectUserCurrency() })
    })

    const checkoutData = await res.json()
    if (checkoutData.error || !checkoutData.url) {
      throw new Error(checkoutData.error || 'Failed to create checkout session')
    }

    const { url } = checkoutData
    window.location.href = url
  } catch (err) {
    console.error('startCheckout failed:', err)
    if (btn) { btn.disabled = false; btn.textContent = 'Subscribe' }
    showToast('Could not start checkout. Please try again.', 'error')
  }
}

async function openCustomerPortal(trigger) {
  if (!authState.isVerified || !authState.sessionToken) {
    openSignInModal()
    return
  }

  // Every Manage Subscription / Manage Billing trigger shares this single
  // portal request and its loading/error state, so only one fresh session URL
  // is ever requested.
  const btn = trigger || document.getElementById('manage-billing-btn')
  const prevText = btn ? btn.textContent : ''
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…' }

  try {
    const res = await fetch(`${BUILDSHIP_BASE_URL}/stripe/create-portal-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken: authState.sessionToken })
    })

    const portalData = await res.json()
    if (portalData.error || !portalData.url) throw new Error(portalData.error || 'Failed to open billing portal')
    const { url } = portalData
    window.location.href = url
  } catch (err) {
    console.error('openCustomerPortal failed:', err)
    if (btn) { btn.disabled = false; btn.textContent = prevText }
    showToast('Could not open billing portal. Please try again.', 'error')
  }
}

// Every in-flight BuildShip request registers its controller here so a run
// the user abandoned can cancel its request instead of only discarding the
// response when it lands.
const activeBuildShipControllers = new Set();

/** Cancel every in-flight BuildShip request; the run they served is stale. */
function abortPipelineRequests() {
  activeBuildShipControllers.forEach((controller) => controller.abort());
  activeBuildShipControllers.clear();
}

async function callBuildShip(step, model, prompt, context = {}, images = []) {
  const BUILDSHIP_TIMEOUT_MS = 120000
  const controller = new AbortController()
  activeBuildShipControllers.add(controller)
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, BUILDSHIP_TIMEOUT_MS)

  try {
    const res = await fetch(PIPELINE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(identityState.token ? { Authorization: `Bearer ${identityState.token}` } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        user_id: identityState.userId,
        step,
        model,
        prompt,
        images,
        context,
      }),
    })

    // BuildShip occasionally answers 200 with a bare success token (e.g. "OK")
    // instead of a JSON body. Parse defensively so we surface the raw body in
    // the error rather than crashing on JSON.parse.
    const rawText = await res.text()
    let data = {}
    try {
      data = rawText ? JSON.parse(rawText) : {}
    } catch {
      data = {}
    }

    if (res.status === 429) {
      if (data.serverCount !== undefined) {
        localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify({ count: data.serverCount, month: getCurrentYearMonth() }))
        updateUsageDisplay()
      }
      const usageError = new Error(data.message || 'Monthly usage limit reached. Upgrade to continue.')
      usageError.isUsageLimit = true
      // The step is the authoritative signal the pipeline view uses to mark
      // which stage stopped; a quota message carries no step prefix of its own.
      usageError.pipelineStep = step
      throw usageError
    }

    const modelArmorError = createModelArmorError(data, step)
    if (modelArmorError) throw modelArmorError

    console.log(`[BuildShip] ${step} response keys:`, Object.keys(data), 'content type:', typeof data.content)
    if (!res.ok) {
      throw new Error(`${data.message || data.error || 'BuildShip pipeline error'} (HTTP ${res.status})`)
    }

    if (step === 'generator') {
      if (data.usage_status === 'success' && Number.isFinite(data.usage_count)) {
        const cm = getCurrentYearMonth()
        const sm = data.usage_month || cm
        if (sm === cm) {
          localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify({ count: data.usage_count, month: cm }))
          updateUsageDisplay()
        }
      } else {
        incrementUsage()
        updateUsageDisplay()
      }
    }

    let output = data.output || data.content
    if (!output) {
      const body = rawText ? ` (body: ${rawText.slice(0, 120)})` : ''
      throw new Error(`BuildShip returned no output for step "${step}"${body}`)
    }

    // Coerce non-string content (OpenRouter may return array of content parts)
    if (Array.isArray(output)) {
      output = output
        .map(part => typeof part === 'string' ? part : part.text || '')
        .join('')
    }
    if (typeof output !== 'string') {
      output = JSON.stringify(output)
    }
    return output
  } catch (error) {
    if (error.name === 'AbortError') {
      if (timedOut) {
        throw new Error(`BuildShip ${step} timed out after ${BUILDSHIP_TIMEOUT_MS / 1000}s`)
      }
      // The run that owned this request was abandoned, so the cancellation
      // must never read as a service outcome.
      const cancelled = new Error(`BuildShip ${step} request cancelled`)
      cancelled.isPipelineCancel = true
      throw cancelled
    }
    if (error instanceof TypeError) {
      throw new Error(`BuildShip unreachable: ${error.message}`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
    activeBuildShipControllers.delete(controller)
  }
}

// Set when the user returns from Stripe with `?checkout=success`. The paid
// entitlement is never granted by the return param itself — it is only ever
// set by the subscription reconciliation below. This flag defers the "plan
// active" confirmation until after reconcileSubscription has confirmed a paid
// tier, so a return that has NOT reconciled (blocked, webhook lag, or a
// cancelled/failed session) can never be reported as subscribed (STU-382
// criterion 3).
let checkoutConfirmPending = false

function handleCheckoutRedirect() {
  const params = new URLSearchParams(window.location.search)
  const checkout = params.get('checkout')
  if (checkout === 'success') {
    window.history.replaceState({}, '', window.location.pathname + window.location.hash)
    clearSubscriptionCache()
    checkoutConfirmPending = true
  } else if (checkout === 'cancel') {
    window.history.replaceState({}, '', window.location.pathname + window.location.hash)
    showToast('Checkout cancelled.', 'info')
  }
  return checkout
}

// Called once the subscription has been reconciled after a checkout return.
// Only reports a live plan when the contract is actually paid; otherwise it
// says the subscription is still being confirmed so the UI never claims a
// subscribed state it cannot back up.
function confirmCheckoutAfterReconcile() {
  if (!checkoutConfirmPending) return
  checkoutConfirmPending = false
  const isPaid = subscriptionState.tier !== 'free'
  showToast(
    isPaid
      ? 'Subscription active! Your plan is live.'
      : 'Checkout complete — confirming your subscription. Check Manage billing if it does not update.',
    isPaid ? 'success' : 'info',
  )
}

// --- SUBSCRIPTION UI ---

function updateSubscriptionUI() {
  const signedIn = authState.isVerified && !!authState.email
  const tier = subscriptionState.tier
  const loading = signedIn && isSubscriptionLoading()
  const resolved = !signedIn || isSubscriptionResolved()

  const badge = document.getElementById('subscription-tier-badge')
  if (badge) {
    const labels = planLabels
    const colors = {
      free: 'bg-gray-100 text-gray-600',
      professional: 'bg-indigo-100 text-indigo-700',
      power: 'bg-purple-100 text-purple-700',
      unresolved: 'bg-red-50 text-red-600',
    }
    badge.textContent = loading ? 'Checking…' : resolved ? labels[tier] || 'Free' : 'Plan unavailable'
    badge.className = `inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${resolved ? colors[tier] || colors.free : colors.unresolved}`
  }

  const upgradePrompt = document.getElementById('upgrade-prompt')
  if (upgradePrompt) upgradePrompt.classList.toggle('hidden', !signedIn || loading || !resolved || tier !== 'free')

  const manageBillingBtn = document.getElementById('manage-billing-btn')
  if (manageBillingBtn) manageBillingBtn.classList.toggle('hidden', !signedIn || loading || (resolved && tier === 'free'))

  updatePricingModalState(resolved ? tier : null)
  updateModelSelectorGating()
  updatePromptImageAvailability()
  updateUsageDisplay()
  updateShellUI()
}

function updatePricingModalState(tier) {
  const disabledClasses = ['bg-gray-100', 'text-gray-500', 'cursor-default']
  const configs = {
    professional: { btnId: 'checkout-btn-professional', defaultText: 'Subscribe' },
    power: { btnId: 'checkout-btn-power', defaultText: 'Subscribe' }
  }
  Object.entries(configs).forEach(([t, { btnId, defaultText }]) => {
    const btn = document.getElementById(btnId)
    if (!btn) return
    if (t === tier) {
      btn.disabled = true
      btn.textContent = 'Current plan'
      btn.classList.add(...disabledClasses)
    } else {
      btn.disabled = false
      btn.textContent = defaultText
      btn.classList.remove(...disabledClasses)
    }
  })
  const freeCurrent = document.getElementById('free-tier-current')
  if (freeCurrent) freeCurrent.classList.toggle('hidden', tier !== 'free')
}

// Render every plan card's feature list from the single PLAN_FEATURES source,
// so the plans page and the pricing modal share one feature set and can never
// drift (and a test can never assert a constant the UI does not render). Each
// .pm-card carries data-tier; its <ul class="pm-features"> is filled from
// PLAN_FEATURES[tier]. Idempotent: safe to run more than once.
function renderPlanFeatureLists() {
  document.querySelectorAll('.pm-card[data-tier]').forEach((card) => {
    const tier = card.dataset.tier
    const rows = planFeatures[tier]
    if (!rows) return
    const ul = card.querySelector('ul.pm-features')
    if (!ul) return
    ul.innerHTML = ''
    for (const row of rows) {
      const li = document.createElement('li')
      li.textContent = row
      ul.appendChild(li)
    }
  })
}

function updatePricingDisplay() {
  const currency = detectUserCurrency()
  const proEl = document.getElementById('pro-price')
  const powerEl = document.getElementById('power-price')
  const plansProEl = document.getElementById('plans-pro-price')
  const plansPowerEl = document.getElementById('plans-power-price')
  const proNote = document.getElementById('pro-price-note')
  const powerNote = document.getElementById('power-price-note')
  const plansProNote = document.getElementById('plans-pro-price-note')
  const plansPowerNote = document.getElementById('plans-power-price-note')

  if (proEl) proEl.textContent = formatPrice(BASE_PRICES_AUD.professional, currency)
  if (powerEl) powerEl.textContent = formatPrice(BASE_PRICES_AUD.power, currency)
  if (plansProEl) plansProEl.textContent = formatPrice(BASE_PRICES_AUD.professional, currency)
  if (plansPowerEl) plansPowerEl.textContent = formatPrice(BASE_PRICES_AUD.power, currency)

  const note = 'billed monthly'
  if (proNote) proNote.textContent = note
  if (powerNote) powerNote.textContent = note
  if (plansProNote) plansProNote.textContent = note
  if (plansPowerNote) plansPowerNote.textContent = note
}

function openPricingModal() {
  updatePricingDisplay()
  const modal = document.getElementById('pricing-modal')
  if (modal) openModal(modal)
  fetchAudExchangeRates().then(() => updatePricingDisplay())
}

function closePricingModal(event) {
  if (event && event.target !== event.currentTarget) return
  const modal = document.getElementById('pricing-modal')
  if (modal) closeModal(modal)
}

function showToast(message, type = 'info') {
  const colors = { success: 'bg-green-600 text-white', error: 'bg-red-600 text-white', warning: 'bg-amber-500 text-white', info: 'bg-gray-800 text-white' }
  const toast = document.createElement('div')
  toast.className = `fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-lg text-sm font-medium shadow-lg z-50 transition-opacity duration-300 ${colors[type] || colors.info}`
  toast.textContent = message
  document.body.appendChild(toast)
  setTimeout(() => {
    toast.style.opacity = '0'
    setTimeout(() => toast.remove(), 300)
  }, 3500)
}

// --- INITIALIZATION ---

document.addEventListener("DOMContentLoaded", async () => {
  initializeModalShells();

  // Initialize highlight.js
  hljs.configure({
    tabReplace: "  ",
    classPrefix: "hljs-",
  });

  // Initialize welcome video
  initializeWelcomeVideo();

  // Decorative hero mark field (WebGL with 2D fallback); no dependency on generation state.
  window.__heroField = initHeroMarkField();

  await initializeAuth();
  handleCheckoutRedirect();
  await fetchSubscription();
  confirmCheckoutAfterReconcile();
  updateSubscriptionUI();
  updatePricingDisplay();
  renderPlanFeatureLists();

  // Initialize API keys and check connection
  await checkConnection();

  // Setup FlutterFlow credential validation
  setupFlutterFlowValidation();

  // Initialize endpoint selector
  const endpointSelect = document.getElementById("flutterflow-endpoint-select");
  if (endpointSelect) {
    const savedEndpoint = getFlutterFlowEndpoint();
    endpointSelect.value = savedEndpoint;
  }

  showWalkthroughIfNeeded();
  resolveIdentity();
  if (IS_DEV && new URLSearchParams(window.location.search).get("debugBundle") === "multi") {
    setTimeout(showDebugMultiArtifactResults, 0);
    setTimeout(showDebugMultiArtifactResults, 1600);
  }
  // Walkthrough step tracking
  const pipelineInput = document.getElementById("pipeline-input");
  if (pipelineInput) {
    pipelineInput.addEventListener("input", () => {
      if (walkthroughStep === 2 && pipelineInput.value.trim().length > 0) {
        advanceWalkthrough();
        updateWalkthroughUI();
      }
    });

    pipelineInput.addEventListener("blur", () => {
      const walkthroughModal = document.getElementById("walkthrough-modal");
      if (walkthroughStep === 2 && walkthroughModal) {
        openModal(walkthroughModal);
      }
    });

    pipelineInput.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        const walkthroughModal = document.getElementById("walkthrough-modal");
        if (walkthroughStep === 2 && walkthroughModal) {
          setTimeout(() => {
            openModal(walkthroughModal);
          }, 100);
        }
      }
    });
  }


  window.addEventListener("commitStateChange", (event) => {
    const { state } = event.detail;

    if (
      state === CommitState.PREPARING ||
      state === CommitState.VALIDATING ||
      state === CommitState.PUSHING
    ) {
      // Only open the overlay for flows that didn't open it themselves;
      // re-opening mid-commit would reset the progress back to step one.
      if (!commitProgress.phaseId) showCommitProgress();
      updateProgressFromState(state);
    } else if (state === CommitState.SUCCESS || state === CommitState.ERROR) {
      updateProgressFromState(state);
      setTimeout(hideCommitProgress, 1000);
    }
  });

  bindHeroChips();
  restoreViewFromHash();
});

// --- WELCOME VIDEO FUNCTIONS ---
function initializeWelcomeVideo() {
  const previewContainer = document.getElementById("preview-frame-container");
  if (previewContainer) {
    previewContainer.style.display = "";
  }
}

function handleWelcomeVideoEnd() {
  const video = document.getElementById("welcome-video-player");
  if (video) {
    video.addEventListener("click", dismissWelcomeVideo);
    document.addEventListener("keydown", dismissWelcomeVideo);
  }
}

function dismissWelcomeVideo() {
  const previewContainer = document.getElementById("preview-frame-container");
  const stageContainer = document.getElementById("main-stage-container");
  const readyState = document.getElementById("ready-state");

  if (previewContainer) previewContainer.style.display = "none";
  if (stageContainer) stageContainer.classList.add("visible");
  if (readyState) readyState.classList.remove("hidden");

  const video = document.getElementById("welcome-video-player");
  if (video) {
    video.removeEventListener("click", dismissWelcomeVideo);
  }
  document.removeEventListener("keydown", dismissWelcomeVideo);

  showWalkthroughIfNeeded();
}

// Store commit data for confirmation
let pendingCommitData = null;

/**
 * Populates the deploy-time project dropdown in the commit confirm modal,
 * defaulting to the project configured in API Keys so the stored choice is
 * pre-selected but the final target can be changed before committing.
 */
async function populateConfirmProjectSelect() {
  const select = document.getElementById("confirm-project-select");
  if (!select) return;

  // Only the latest request may write to the shared dropdown. If the modal is
  // closed and reopened while this is in flight, its token falls behind and it
  // bails instead of resetting the selection with stale data.
  const token = ++confirmProjectToken;
  const isCurrent = () => token === confirmProjectToken;

  const apiKey = await getApiKey("flutterflow");
  const storedId = await getApiKey("flutterflow_project_id");
  if (!isCurrent()) return;

  if (!apiKey) {
    select.innerHTML =
      '<option value="">Add your FlutterFlow API Key to select a project</option>';
    select.disabled = true;
    return;
  }

  select.disabled = false;
  select.innerHTML = '<option value="">Loading projects…</option>';
  try {
    const client = new FlutterFlowApiClient(apiKey, "");
    const projects = await client.listProjects();
    if (!isCurrent()) return;

    if (!projects || projects.length === 0) {
      select.innerHTML = '<option value="">No projects found</option>';
      return;
    }

    select.innerHTML = '<option value="">Select a project…</option>';
    projects.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.id || project.projectId || "";
      option.textContent =
        project.name || project.projectName || `Project ${project.id}`;
      select.appendChild(option);
    });

    if (storedId) select.value = storedId;
  } catch (error) {
    if (!isCurrent()) return;
    console.error("Failed to load projects for deploy:", error);
    select.innerHTML =
      '<option value="">Failed to load projects — check your API Key</option>';
  }
}

/**
 * Reads the project chosen in the confirm modal, falling back to the stored
 * API Keys default when none was selected.
 */
function readCommitTargetProjectId() {
  const select = document.getElementById("confirm-project-select");
  const chosen = select?.value?.trim();
  return chosen || null;
}

/**
 * Opens the commit confirmation modal with code details.
 * @param {Object} codeInfo - Prepared code info
 * @param {Object} checks - Pre-commit check results
 * @param {Object} deps - Detected dependencies
 */
function openCommitConfirmModal(codeInfo, checks, deps, bundlePlan = null) {
  pendingCommitData = { codeInfo, checks, deps, bundlePlan };

  document.getElementById("confirm-file-name").textContent = codeInfo.fileName;
  document.getElementById("confirm-artifact-type").textContent =
    codeInfo.artifactType;
  document.getElementById("confirm-file-size").textContent =
    `${(codeInfo.content.length / 1024).toFixed(1)} KB`;
  document.getElementById("confirm-line-count").textContent =
    bundlePlan ? `${bundlePlan.fileEntries.length} files` : codeInfo.content.split("\n").length;

  populateConfirmProjectSelect();

  const depsList = document.getElementById("confirm-deps-list");
  const depsSection = document.getElementById("confirm-deps-section");
  if (deps && Object.keys(deps).length > 0) {
    depsList.innerHTML = Object.entries(deps)
      .map(([name, version]) => {
        // A package with no declared minimum has its version resolved against
        // the project's pubspec at push time, so promising one here would lie.
        const constraint = version
          ? `at least ${escapeHtmlText(version)}`
          : "version resolved from your project";
        return `<li>• ${escapeHtmlText(name)}: ${constraint}</li>`;
      })
      .join("");
    depsSection.classList.remove("hidden");
  } else {
    depsSection.classList.add("hidden");
  }

  const warningsList = document.getElementById("confirm-warnings-list");
  const warningsSection = document.getElementById("confirm-warnings-section");
  if (checks.warnings && checks.warnings.length > 0) {
    warningsList.innerHTML = checks.warnings
      .map((w) => `<li>• ${escapeHtmlText(w)}</li>`)
      .join("");
    warningsSection.classList.remove("hidden");
  } else {
    warningsSection.classList.add("hidden");
  }

  document.getElementById("confirm-code-preview").textContent =
    codeInfo.content;

  document.getElementById("code-preview-content").classList.add("hidden");
  document.getElementById("code-preview-chevron").style.transform =
    "rotate(0deg)";

  const modal = document.getElementById("commit-confirm-modal");
  if (modal) {
    openModal(modal);
  }
}

/**
 * Closes the commit confirmation modal.
 * @param {Event} [event] - Optional click event
 */
function closeCommitConfirmModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById("commit-confirm-modal");
  if (modal) {
    closeModal(modal);
  }
  pendingCommitData = null;
}

/**
 * Closes the commit success modal and resets all success fields.
 * @param {Event} [event] - Optional click event (may be undefined)
 */
function closeCommitSuccessModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById("commit-success-modal");
  if (modal) {
    closeModal(modal);
  }

  // Reset success fields
  const fieldIds = [
    "success-message",
    "success-project-id",
    "success-file-name",
    "success-artifact-type",
    "success-time",
    "success-size",
  ];
  for (const id of fieldIds) {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  }

  // Hide warnings section
  const warningsSection = document.getElementById("success-warnings-section");
  if (warningsSection) {
    warningsSection.classList.add("hidden");
  }
  const warningsList = document.getElementById("success-warnings-list");
  if (warningsList) {
    warningsList.innerHTML = "";
  }
}

function showCommitSuccessModal(result) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || "";
  };

  const fileName = result.metadata?.fileName || "";
  const projectId = result.metadata?.projectId || "";
  const artifactType = result.metadata?.artifactType || "";
  const elapsed = result.elapsedTime ? `${(result.elapsedTime / 1000).toFixed(1)}s` : "";
  const size = result.metadata?.codeSize ? `${(result.metadata.codeSize / 1024).toFixed(1)} KB` : "";

  set("success-message", result.message || "Code committed successfully!");
  set("success-project-id", projectId);
  set("success-file-name", fileName);
  set("success-artifact-type", artifactType);
  set("success-time", elapsed);
  set("success-size", size);

  // Only worth a row when the deploy actually changed the project's pubspec.
  const addedDeps = result.addedDependencies || [];
  const depsRow = document.getElementById("success-deps-row");
  if (depsRow) depsRow.classList.toggle("hidden", addedDeps.length === 0);
  set("success-deps", addedDeps.join(", "));

  const ffLink = document.getElementById("success-open-ff-link");
  if (ffLink && projectId) {
    ffLink.href = `https://app.flutterflow.io/project/${projectId}`;
  }

  const warningsSection = document.getElementById("success-warnings-section");
  const warningsList = document.getElementById("success-warnings-list");
  // A class that could not be compiled before the push is reported here rather
  // than left implicit, so "deployed" never reads as "checked". A class that
  // was compiled against a reduced package graph is reported beside it: the
  // check ran, but approximately, and that has to stay visible too.
  const unverified = result.unverified || [];
  const approximate = result.approximate || [];
  const fileWarnings = result.warnings || [];
  if (
    (fileWarnings.length > 0 || unverified.length > 0 || approximate.length > 0) &&
    warningsSection &&
    warningsList
  ) {
    warningsList.innerHTML = [
      ...unverified.map((reason) =>
        `<li><span class="font-medium">Not verified before deploying:</span> ${escapeHtml(String(reason))}</li>`
      ),
      ...approximate.map((notice) =>
        `<li><span class="font-medium">Verified approximately:</span> ${escapeHtml(String(notice))}</li>`
      ),
      ...fileWarnings.map(([file, errs]) =>
        `<li><span class="font-medium">${escapeHtml(file)}:</span> ${escapeHtml(String(errs))}</li>`
      ),
    ].join("");
    warningsSection.classList.remove("hidden");
  }

  const modal = document.getElementById("commit-success-modal");
  if (modal) openModal(modal);
}

function showCommitFailureModal(result) {
  hideCommitProgress();
  showCommitError(result);
}

/**
 * Populates the shared terminal modal for the two outcomes that are real but
 * are neither a clean success nor a clean failure: PARTIAL (some custom
 * classes were written, the remaining sync failed) and UNCONFIRMED (the remote
 * outcome is unknown because the client stopped waiting or the stream
 * dropped). It always shows the same target identity the user confirmed, the
 * per-file outcomes when the runner/push reported them, and reconciliation
 * guidance that never hides the manual FlutterFlow step of checking the
 * project.
 */
function populateCommitTerminalModal(result, { heading, title, guidance }) {
  const identity = result.targetIdentity || {};
  const modal = document.getElementById("commit-terminal-modal");
  if (!modal) return false;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || "";
  };

  set("terminal-heading", heading);
  set("terminal-title", title);
  set("terminal-message", result.error || result.message || "");

  const idList = document.getElementById("terminal-identity-list");
  if (idList) {
    const rows = [
      ["Project", identity.projectId || result.metadata?.projectId],
      ["Endpoint", identity.endpoint],
      ["File", identity.fileName || result.metadata?.fileName],
      ["Artifact", identity.artifactType || result.metadata?.artifactType],
    ];
    idList.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div class="flex justify-between gap-3"><span class="text-gray-400">${escapeHtml(
            label,
          )}:</span><span class="font-medium text-gray-700">${escapeHtml(
            String(value ?? "—"),
          )}</span></div>`,
      )
      .join("");
  }

  const fileList = document.getElementById("terminal-file-outcomes");
  let errorMap = result.errorMap;
  if (errorMap && !(errorMap instanceof Map)) {
    errorMap = new Map(Object.entries(errorMap));
  }
  if (fileList && errorMap && errorMap.size > 0) {
    fileList.innerHTML = [...errorMap.entries()]
      .map(
        ([file, info]) =>
          `<li class="py-1.5 border-b border-gray-100 last:border-0 text-xs text-gray-700"><span class="font-semibold">${escapeHtml(
            file,
          )}:</span> ${escapeHtml(formatFlutterFlowFileError(info))}</li>`,
      )
      .join("");
    fileList.classList.remove("hidden");
  } else if (fileList) {
    fileList.classList.add("hidden");
  }

  const guidanceEl = document.getElementById("terminal-guidance");
  if (guidanceEl) guidanceEl.innerHTML = guidance;

  const ffLink = document.getElementById("terminal-open-ff-link");
  const projectId = identity.projectId || result.metadata?.projectId;
  if (ffLink) {
    ffLink.href = projectId
      ? `https://app.flutterflow.io/project/${projectId}`
      : "https://app.flutterflow.io/";
  }

  openModal(modal);
  return true;
}

/**
 * Terminal outcome: some custom classes were written to FlutterFlow, but the
 * remaining sync was rejected. "Committed" would lie — part of the deploy did
 * land, but part failed.
 */
function showCommitPartialModal(result) {
  populateCommitTerminalModal(result, {
    heading: "Deploy partially applied",
    title:
      "Some custom classes reached FlutterFlow, but the deploy did not fully complete.",
    guidance:
      "The custom classes the runner confirmed are already in your project and are <strong>not lost</strong>. " +
      "Review the per-file errors above, fix them in FlutterFlow or regenerate, then deploy again. " +
      "Open the project to see exactly what landed.",
  });
}

/**
 * Terminal outcome: the client stopped waiting (bounded UI timeout) or the
 * connection dropped before the runner reported a result. The remote outcome
 * is unknown — this is never reported as committed or as failed, and the
 * in-flight write is never cancelled.
 */
function showCommitUnconfirmedModal(result) {
  populateCommitTerminalModal(result, {
    heading: "Deploy outcome not yet known",
    title:
      "This browser stopped waiting before the FlutterFlow server reported a result.",
    guidance:
      "The deploy may still be finishing on the server — it was <strong>not cancelled</strong>. " +
      "Open your FlutterFlow project and confirm whether the class landed before retrying, so you do not " +
      "push a duplicate or build on top of an unknown state.",
  });
}

/**
 * Closes the shared terminal modal (partial / unconfirmed outcomes).
 * @param {Event} [event] - Optional click event
 */
function closeCommitTerminalModal(event) {
  if (event && event.target !== event.currentTarget) return;
  closeModal(document.getElementById("commit-terminal-modal"));
}

/**
 * Toggles the code preview section.
 */
function toggleCodePreview() {
  const content = document.getElementById("code-preview-content");
  const chevron = document.getElementById("code-preview-chevron");

  if (content.classList.contains("hidden")) {
    content.classList.remove("hidden");
    chevron.style.transform = "rotate(90deg)";
  } else {
    content.classList.add("hidden");
    chevron.style.transform = "rotate(0deg)";
  }
}

/**
 * Commit phases, each owning a slice of the progress bar. The bar eases
 * forward inside its slice while a phase runs, so a long phase still looks
 * alive.
 */
const CommitPhases = {
  prepare: { message: "Preparing your code...", start: 4, end: 14 },
  validate: {
    message: "Checking FlutterFlow credentials...",
    start: 14,
    end: 22,
  },
  project: { message: "Reading your FlutterFlow project...", start: 22, end: 40 },
  provision: {
    message: "Creating custom classes in FlutterFlow...",
    start: 40,
    end: 82,
  },
  package: { message: "Packaging files for upload...", start: 82, end: 88 },
  push: { message: "Pushing to FlutterFlow...", start: 88, end: 97 },
  done: { message: "Complete!", start: 100, end: 100 },
};

/**
 * Fallback sub-status for the custom class deploy, used only until the runner
 * reports its first real phase. A runner that predates streaming never does,
 * so this stays as the estimate for the whole request.
 */
const PROVISION_SUBSTATUS = [
  { after: 0, text: "Starting a FlutterFlow build runner..." },
  { after: 12, text: "Preparing the FlutterFlow AI workspace..." },
  { after: 35, text: "Uploading your custom classes..." },
  { after: 60, text: "FlutterFlow is applying the changes..." },
  { after: 100, text: "Still working — this can take a couple of minutes..." },
];

const commitProgress = {
  sequence: [],
  phaseId: null,
  phaseStartedAt: null,
  timer: null,
  substatus: null,
  liveSubstatus: false,

  /**
   * Opens the overlay and starts a fresh run.
   * @param {Object} options
   * @param {boolean} options.withProvisioning - Include the custom class
   *   provisioning step, which is only run for CodeFile artifacts.
   */
  start({ withProvisioning = false } = {}) {
    this.sequence = ["prepare", "validate", "project"];
    if (withProvisioning) this.sequence.push("provision");
    this.sequence.push("package", "push", "done");

    const overlay = document.getElementById("commit-progress-overlay");
    if (overlay) {
      setModalPending(overlay, true, "Deploying to FlutterFlow");
      openModal(overlay);
    }

    this.set("prepare");
  },

  /**
   * Moves to a phase. Phases not in the current sequence are appended in
   * place, so an unexpected provisioning run still gets its own step.
   * @param {string} phaseId - Key of CommitPhases
   * @param {string} [substatus] - Extra line shown under the step counter
   */
  set(phaseId, substatus = null) {
    if (!CommitPhases[phaseId] || phaseId === this.phaseId) return;
    if (!this.sequence.includes(phaseId)) {
      const before = this.sequence.indexOf("package");
      this.sequence.splice(before === -1 ? this.sequence.length : before, 0, phaseId);
    }

    this.phaseId = phaseId;
    this.phaseStartedAt = Date.now();
    this.substatus = substatus;
    this.liveSubstatus = false;
    this.render();

    if (this.timer) clearInterval(this.timer);
    if (phaseId !== "done") {
      this.timer = setInterval(() => this.render(), 500);
    }
  },

  /**
   * Reports a phase the deploy runner sent back. Real phases replace the
   * estimated timeline for the rest of the step.
   * @param {string} text - Message to show under the step counter
   */
  setSubstatus(text) {
    if (!text) return;
    this.liveSubstatus = true;
    this.substatus = text;
    this.render();
  },

  /** Renders the current phase, easing the bar toward the phase's end. */
  render() {
    const phase = CommitPhases[this.phaseId];
    if (!phase) return;

    const elapsed = (Date.now() - this.phaseStartedAt) / 1000;
    // Approach the phase's end asymptotically; a phase never claims to be
    // finished until the next one actually starts.
    const eased = phase.start + (phase.end - phase.start) * (1 - Math.exp(-elapsed / 25));

    if (this.phaseId === "provision" && !this.liveSubstatus) {
      const stage = PROVISION_SUBSTATUS.filter((s) => elapsed >= s.after).pop();
      if (stage) this.substatus = stage.text;
    }

    const index = this.sequence.indexOf(this.phaseId);
    const step = index === -1 ? 1 : index + 1;
    const detailParts = [`Step ${step} of ${this.sequence.length}`];
    if (elapsed >= 5) detailParts.push(formatCommitElapsed(elapsed));

    updateCommitProgress(
      this.phaseId === "done" ? 100 : eased,
      phase.message,
      detailParts.join(" · "),
      this.substatus,
    );
  },

  /** Stops the ticker and hides the overlay. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.phaseId = null;
    const overlay = document.getElementById("commit-progress-overlay");
    if (overlay) {
      setModalPending(overlay, false);
      closeModal(overlay, { force: true, restoreFocus: false });
    }
  },
};

function formatCommitElapsed(seconds) {
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s elapsed`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s elapsed`;
}

/**
 * Shows the commit progress overlay.
 * @param {Object} [options] - Passed through to commitProgress.start
 */
function showCommitProgress(options) {
  commitProgress.start(options);
}

/**
 * Hides the commit progress overlay.
 */
function hideCommitProgress() {
  commitProgress.stop();
}

/**
 * Updates the commit progress UI.
 * @param {number} percent - Progress percentage (0-100)
 * @param {string} message - Status message
 * @param {string} detail - Detailed step info
 * @param {string} [substatus] - Live sub-status for long-running steps
 */
function updateCommitProgress(percent, message, detail, substatus = null) {
  const progressBar = document.getElementById("commit-progress-bar");
  const progressMessage = document.getElementById("progress-message");
  const progressDetail = document.getElementById("progress-detail");
  const progressSubstatus = document.getElementById("progress-substatus");

  if (progressBar) {
    progressBar.style.width = `${Math.round(percent * 10) / 10}%`;
  }
  if (progressMessage) {
    progressMessage.textContent = message;
  }
  if (progressDetail) {
    progressDetail.textContent = detail;
  }
  if (progressSubstatus) {
    progressSubstatus.textContent = substatus || "";
    progressSubstatus.classList.toggle("hidden", !substatus);
  }
}

/**
 * Maps commit state to a progress phase. Only covers the coarse states; the
 * commit flows report the finer phases themselves.
 * @param {string} state - CommitState value
 */
function updateProgressFromState(state) {
  const statePhaseMap = {
    [CommitState.PREPARING]: "prepare",
    [CommitState.VALIDATING]: "validate",
    [CommitState.PUSHING]: "project",
    [CommitState.SUCCESS]: "done",
  };

  if (state === CommitState.ERROR) {
    if (commitProgress.timer) clearInterval(commitProgress.timer);
    commitProgress.timer = null;
    updateCommitProgress(100, "Failed", "Error occurred");
    return;
  }

  const phaseId = statePhaseMap[state];
  if (phaseId) commitProgress.set(phaseId);
}

/**
 * Whether a commit will need the custom class provisioning step, which is the
 * slow Cloud Run deploy.
 * @param {Object} commitData - Pending commit data (bundle plan or single file)
 * @returns {boolean} True if any artifact is a custom code file
 */
function commitNeedsProvisioning(commitData) {
  if (commitData.bundlePlan) {
    return commitData.bundlePlan.fileEntries.some(
      (entry) => entry.type === CodeType.CODE_FILE,
    );
  }
  return commitData.codeInfo?.codeType === CodeType.CODE_FILE;
}

/**
 * Confirms the commit after modal review.
 */
// A deploy is in flight. The confirm action and the deploy toggle are disabled
// for its whole run, so a user clicking twice cannot start a second push and a
// second modal cannot be opened over a live one.
let deployInFlight = false;

function setDeployBusy(busy) {
  deployInFlight = busy;
  // The modal's confirm button and every deploy trigger are disabled for the
  // whole run so a second click cannot start an overlapping push.
  const confirm = document.querySelector(
    "#commit-confirm-modal button[data-deploy-confirm]",
  );
  if (confirm) confirm.disabled = busy;
  const triggers = [
    ...document.querySelectorAll("[data-deploy-start]"),
    ...document.querySelectorAll("#btn-deploy-to-ff"),
  ];
  triggers.forEach((el) => {
    el.disabled = busy;
  });
}

/**
 * Dispatches a deploy result to the single truthful terminal presentation.
 * Every outcome releases the UI busy state; only COMMITTED reaches the success
 * modal. Partial and unconfirmed get their own truthful modals.
 * @param {Object} result - A deploy result (see deployOutcome.classifyDeployResult)
 */
function renderCommitTerminal(result) {
  hideCommitProgress();
  setDeployBusy(false);
  const outcome = classifyDeployResult(result);
  if (outcome === DeployOutcome.COMMITTED) {
    showCommitSuccessModal(result);
  } else if (outcome === DeployOutcome.PARTIAL) {
    showCommitPartialModal(result);
  } else if (outcome === DeployOutcome.UNCONFIRMED) {
    showCommitUnconfirmedModal(result);
  } else {
    showCommitFailureModal(result);
  }
}

async function confirmCommitToFlutterFlow() {
  if (!pendingCommitData) {
    console.error("No pending commit data");
    return;
  }
  if (deployInFlight) {
    console.warn("Deploy already in flight; ignoring duplicate confirm.");
    return;
  }

  // Null the pending data before any await: it is only cleared at the end of
  // this function otherwise, so a second confirm click landing mid-commit
  // would read the same data and push twice concurrently. The deploy-in-flight
  // guard above makes this doubly safe.
  const commitData = pendingCommitData;
  pendingCommitData = null;
  commitTargetProjectId = readCommitTargetProjectId();
  closeCommitConfirmModal();
  setDeployBusy(true);
  showCommitProgress({ withProvisioning: commitNeedsProvisioning(commitData) });

  if (commitData.bundlePlan) {
    const result = await executeBundleCommit(commitData.bundlePlan, {
      pipelineResult: {
        step1Result: pipelineState.step1Result,
        selectedModel: document.getElementById("code-generator-model")?.value,
      },
    });

    commitTargetProjectId = null;
    renderCommitTerminal(result);
    return;
  }

  const { codeInfo } = commitData;

  const { artifactType, artifactName, fileName } = getCurrentArtifactMetadata();

  const result = await executeCommit(codeInfo.content, {
    artifactType,
    artifactName,
    fileName,
    pipelineResult: {
      step1Result: pipelineState.step1Result,
      selectedModel: document.getElementById("code-generator-model")?.value,
    },
  });

  commitTargetProjectId = null;
  renderCommitTerminal(result);
}

// Global exports
window.runThinkingPipeline = runThinkingPipeline;
window.toggleStep = toggleStep;
window.toggleSection = toggleSection;
window.selectWorkflowStep = selectWorkflowStep;
window.copyCode = copyCode;
window.retryWithDifferentModel = retryWithDifferentModel;
window.openApiKeysModal = openApiKeysModal;
window.closeApiKeysModal = closeApiKeysModal;
window.closeWalkthroughModal = closeWalkthroughModal;
window.openWalkthroughModal = openWalkthroughModal;
window.advanceWalkthrough = advanceWalkthrough;
window.commitToFlutterFlow = commitToFlutterFlow;

function focusPromptInput() {
  const input = document.getElementById("pipeline-input");
  if (input) {
    input.focus();
  }
}

function openModelSelector() {
  const details = document.getElementById("advanced-settings");
  if (details) details.open = true;
  const select = document.getElementById("code-generator-model");
  if (select) {
    select.scrollIntoView({ behavior: "smooth", block: "center" });
    select.focus();
    select.click();
  }
}

window.focusPromptInput = focusPromptInput;
window.openModelSelector = openModelSelector;
window.handlePromptImageSelect = handlePromptImageSelect;
window.removePromptImage = removePromptImage;
window.saveApiKeys = saveApiKeys;
window.clearAllApiKeys = clearAllApiKeys;
window.toggleKeyVisibility = toggleKeyVisibility;
window.handleWelcomeVideoEnd = handleWelcomeVideoEnd;
window.dismissWelcomeVideo = dismissWelcomeVideo;
window.initiateCommitToFlutterFlow = initiateCommitToFlutterFlow;
window.updateFlutterFlowCredentialStatus = updateFlutterFlowCredentialStatus;
window.openCommitConfirmModal = openCommitConfirmModal;
window.closeCommitConfirmModal = closeCommitConfirmModal;
window.closeCommitSuccessModal = closeCommitSuccessModal
window.closeCommitTerminalModal = closeCommitTerminalModal
window.showCommitPartialModal = showCommitPartialModal
window.showCommitUnconfirmedModal = showCommitUnconfirmedModal
window.showCommitSuccessModal = showCommitSuccessModal
window.showCommitFailureModal = showCommitFailureModal;
window.toggleCodePreview = toggleCodePreview;
window.confirmCommitToFlutterFlow = confirmCommitToFlutterFlow;
window.runRefinement = runRefinement;
window.regenerateFromPastedErrors = regenerateFromPastedErrors;
window.clearErrorInput = clearErrorInput;
window.setFlutterFlowEndpoint = setFlutterFlowEndpoint;
window.getFlutterFlowEndpoint = getFlutterFlowEndpoint;
// Exposed so the deploy progress overlay can be driven in a browser test.
window.commitProgress = commitProgress;
window.openSignInModal = openSignInModal;
window.closeSignInModal = closeSignInModal;
window.handleMagicLinkRequest = handleMagicLinkRequest;
window.handleSignOut = handleSignOut;
window.startCheckout = startCheckout;
window.openCustomerPortal = openCustomerPortal;
window.openPricingModal = openPricingModal;
window.closePricingModal = closePricingModal;

// --- PIPELINE PROGRESS BAR & RESULTS VIEW ---
//
// The three-stage view is bound to the real Architect -> Generator -> Review
// events, so nothing here invents an outcome: the track advances only when a
// stage actually reports, a stage that never ran is never drawn as completed,
// and a failure never falls through to a result. The elapsed counter is the
// only time-driven element, and it reports real elapsed time.
let pipelineElapsedTimer = null;
let pipelineStartTime = null;
// Every view update carries the run it belongs to (pipelineState.runId), so a
// response that arrives after the user started a newer run is discarded
// instead of overwriting the newer run's state.
let pipelineStageStates = { 1: "pending", 2: "pending", 3: "pending" };
let pipelineActiveStage = 1;
let pipelineSelectedStage = null;

const PIPELINE_STAGE_LABELS = {
  1: "Prompt Architect",
  2: "Code Generator",
  3: "Code Review",
};
const PIPELINE_STAGE_TITLES = {
  1: "Understanding your prompt",
  2: "Generating Dart code",
  3: "Running the code audit",
};
const PIPELINE_STAGE_DONE_TITLES = {
  1: "Prompt understood",
  2: "Dart code generated",
  3: "Code audit complete",
};

function startPipelineRun() {
  pipelineState.runId += 1;
  return pipelineState.runId;
}

function isCurrentPipelineRun(runId) {
  return runId === undefined || runId === pipelineState.runId;
}

/**
 * Abandon the current run: its captured id stops matching
 * pipelineState.runId, so every isCurrentPipelineRun check discards whatever
 * it still has in flight. Used when the user leaves the run mid-flight.
 */
function invalidatePipelineRun() {
  pipelineState.runId += 1;
}

function pipelineStageButton(step) {
  return document.getElementById(`pdot-${step}`);
}

/**
 * Busy feedback on the control that started the run, and - just as important -
 * a usable control again when the run terminates, however it terminated.
 * The redesigned shell submits from the composer's send button; the legacy id
 * is still honoured so nothing depends on which shell is mounted.
 */
function setRunPipelineButtonBusy(busy) {
  const button =
    document.getElementById("btn-run-pipeline") ||
    document.getElementById("hero-send");
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-busy", busy);
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function setPipelineRunState(state) {
  const progress = document.getElementById("pipeline-progress");
  if (progress) progress.dataset.runState = state;
}

/**
 * Paint one stage's state. `pending` stages stay unreachable, and a stage that
 * was never reached is never painted `done`.
 * @param {number} step
 * @param {"pending"|"active"|"done"|"failed"|"skipped"} state
 */
function setPipelineStageState(step, state) {
  pipelineStageStates[step] = state;
  const button = pipelineStageButton(step);
  if (!button) return;
  button.dataset.state = state;
  // A stage that never ran is reported as such; there is nothing to select.
  button.disabled = state === "pending" || state === "skipped";
  const stageName = PIPELINE_STAGE_LABELS[step];
  const stateLabels = {
    pending: "not started",
    active: "in progress",
    done: "complete",
    failed: "failed",
    skipped: "not run",
  };
  button.setAttribute(
    "aria-label",
    `Step ${step} of 3, ${stageName}: ${stateLabels[state] || state}`,
  );
  if (state === "active") button.setAttribute("aria-current", "step");
  else button.removeAttribute("aria-current");
}

function completedPipelineStageCount() {
  return [1, 2, 3].filter((step) => pipelineStageStates[step] === "done").length;
}

function renderPipelineTrack() {
  const fillEl = document.getElementById("pipeline-progress-fill");
  if (fillEl) {
    fillEl.style.width = `${(completedPipelineStageCount() / 3) * 100}%`;
  }
  const countEl = document.getElementById("progress-stage-count");
  if (countEl) countEl.textContent = `Step ${pipelineActiveStage} of 3`;
}

/**
 * Write the status line. It lives inside a polite live region, so writing it is
 * also how the run is announced to assistive technology.
 */
function renderPipelineStatus(step, { done = false } = {}) {
  const titleEl = document.getElementById("progress-title-text");
  const substepEl = document.getElementById("progress-substep-text");
  const state = pipelineStageStates[step];
  const finished = done || state === "done";
  if (titleEl) {
    titleEl.textContent = finished
      ? PIPELINE_STAGE_DONE_TITLES[step]
      : PIPELINE_STAGE_TITLES[step];
  }
  if (substepEl) {
    const suffix = finished ? " \u2014 complete" : state === "failed" ? " \u2014 stopped" : "";
    substepEl.textContent = `Step ${step} of 3 \u2014 ${PIPELINE_STAGE_LABELS[step]}${suffix}`;
  }
}

/**
 * Pin the status line to a stage the user chose. Only stages this run actually
 * reached are reachable, so the control can never report an invented state.
 */
function selectPipelineStage(step) {
  if (pipelineStageStates[step] === "pending" || pipelineStageStates[step] === "skipped") return;
  pipelineSelectedStage = step;
  [1, 2, 3].forEach((candidate) => {
    const button = pipelineStageButton(candidate);
    if (button) button.setAttribute("aria-pressed", String(candidate === step));
  });
  renderPipelineStatus(step);
}

function clearPipelineStageSelection() {
  pipelineSelectedStage = null;
  [1, 2, 3].forEach((step) => {
    const button = pipelineStageButton(step);
    if (button) button.removeAttribute("aria-pressed");
  });
}

function setPipelineNote(text) {
  const note = document.getElementById("pipeline-note");
  if (!note) return;
  note.textContent = text || "";
  note.hidden = !text;
}

/**
 * A model fallback is a real service event, so it is reported rather than
 * hidden - but the run is still in flight, so it is a note, not a failure.
 */
function notePipelineFallback(primaryModel, fallbackModel, runId) {
  if (!isCurrentPipelineRun(runId)) return;
  setPipelineNote(
    `${getModelLabel(primaryModel)} did not answer. Continuing on ${getModelLabel(fallbackModel)}.`,
  );
}

function hidePipelineFailure() {
  const panel = document.getElementById("pipeline-failure");
  if (!panel) return;
  panel.hidden = true;
  const actions = document.getElementById("pipeline-failure-actions");
  if (actions) actions.replaceChildren();
}

// --- COMPOSER -> PIPELINE -> RESULTS OUTLINE MORPH ---
//
// The authored hand-off: a coral outline leaves the composer's rect and grows
// into the generation panel's, then the panel's into the expanded Results
// view, on the 1120ms --t-morph clock. It is decorative only - the real view
// is already in place underneath before the outline moves, so the animation
// can never delay, gate or invent a service outcome. It is skipped under
// reduced motion and torn down on resize, navigation and interruption.
const PIPELINE_MORPH_FALLBACK_MS = 1120;

/** The authored morph clock, read from the --t-morph design token. */
function pipelineMorphDurationMs() {
  const token = getComputedStyle(document.documentElement)
    .getPropertyValue("--t-morph")
    .trim();
  const parsed = Number.parseFloat(token);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PIPELINE_MORPH_FALLBACK_MS;
}

let pipelineMorphGhost = null;
let pipelineMorphAnimation = null;

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function cancelPipelineMorph() {
  if (pipelineMorphAnimation) {
    try {
      pipelineMorphAnimation.cancel();
    } catch {
      /* an already-finished animation cannot be cancelled */
    }
    pipelineMorphAnimation = null;
  }
  if (pipelineMorphGhost) {
    pipelineMorphGhost.remove();
    pipelineMorphGhost = null;
  }
  window.removeEventListener("resize", cancelPipelineMorph);
}

function runOutlineMorph(fromEl, toEl) {
  cancelPipelineMorph();
  if (prefersReducedMotion() || !fromEl || !toEl || !document.body) return;
  if (typeof Element.prototype.animate !== "function") return;

  const from = fromEl.getBoundingClientRect();
  const to = toEl.getBoundingClientRect();
  if (!from.width || !from.height || !to.width || !to.height) return;

  const ghost = document.createElement("div");
  ghost.className = "composer-morph";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px;opacity:0;`;
  document.body.appendChild(ghost);

  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  const base = `translate(${dx}px,${dy}px) scale(${sx},${sy})`;

  // 0-14%: the outline eases in over the surface it is leaving. 14-28%: the
  // anticipatory shrink. 28-100%: one longer growth that settles with weight.
  const animation = ghost.animate(
    [
      { transform: base, opacity: 0, offset: 0, easing: "cubic-bezier(.2,0,0,1)" },
      { transform: base, opacity: 1, offset: 0.14, easing: "cubic-bezier(.4,0,.2,1)" },
      {
        transform: `translate(${dx}px,${dy}px) scale(${sx * 0.93},${sy * 0.93})`,
        opacity: 1,
        offset: 0.28,
        easing: "cubic-bezier(.32,1.38,.5,1)",
      },
      { transform: "translate(0px,0px) scale(1,1)", opacity: 1, offset: 1 },
    ],
    { duration: pipelineMorphDurationMs(), fill: "both" },
  );

  pipelineMorphGhost = ghost;
  pipelineMorphAnimation = animation;
  window.addEventListener("resize", cancelPipelineMorph);

  animation.onfinish = () => {
    if (pipelineMorphGhost !== ghost) return;
    const out = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 260,
      fill: "forwards",
    });
    out.onfinish = () => {
      if (pipelineMorphGhost === ghost) cancelPipelineMorph();
    };
  };
}

/** Composer -> generation panel. */
function morphComposerToPipeline() {
  const from = document.getElementById("composer");
  const fromRect = from?.getBoundingClientRect();
  if (!fromRect) return;
  // The generation stage only gains a box once it is revealed a frame later,
  // so the outline is measured against the panel that is actually on screen.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      runOutlineMorph(
        { getBoundingClientRect: () => fromRect },
        document.getElementById("main-stage-container"),
      );
    });
  });
}

/** Generation panel -> expanded Results view. */
function morphPipelineToResults() {
  runOutlineMorph(
    document.getElementById("pipeline-progress"),
    document.getElementById("main-stage-container"),
  );
}

// Navigating away abandons the hand-off rather than leaving an orphaned
// outline floating over another surface.
window.addEventListener("hashchange", cancelPipelineMorph);
window.addEventListener("popstate", cancelPipelineMorph);

function showPipelineProgress(options = {}) {
  const { prompt = null, runId } = options;
  if (!isCurrentPipelineRun(runId)) return;
  // A previous run's delayed hide must not blank this run's panel.
  cancelPipelineHideTimer();

  setGenerationStageVisible(true);
  const progress = document.getElementById("pipeline-progress");
  const resultsView = document.getElementById("results-view");
  const readyState = document.getElementById("ready-state");

  if (readyState) readyState.classList.add("hidden");
  if (resultsView) resultsView.classList.remove("visible");
  document.body.classList.remove("results-fullscreen", "results-with-sidebar");
  if (progress) progress.classList.add("visible");
  setPipelineRunState("running");

  if (prompt !== null) {
    const promptEl = document.getElementById("pipeline-submitted-prompt");
    if (promptEl) promptEl.textContent = prompt;
  }

  pipelineStartTime = Date.now();
  // The elapsed counter is the only time-driven element: start each run at
  // zero rather than showing the previous run's final reading until the
  // first tick lands.
  const elapsedEl = document.getElementById("progress-elapsed");
  if (elapsedEl) elapsedEl.textContent = "0s";
  pipelineStageStates = { 1: "pending", 2: "pending", 3: "pending" };
  clearPipelineStageSelection();
  hidePipelineFailure();
  setPipelineNote("");
  [1, 2, 3].forEach((step) => setPipelineStageState(step, "pending"));

  updatePipelineProgressStep(1, runId);
  startProgressTimer();
}

/**
 * Enter a stage. Stages before it that never ran stay `skipped` - the refine
 * and fix-from-errors flows re-enter at stage 2, and their untouched Architect
 * stage must not read as completed work.
 */
function updatePipelineProgressStep(step, runId) {
  if (!isCurrentPipelineRun(runId)) return;
  pipelineActiveStage = step;
  clearPipelineStageSelection();

  [1, 2, 3].forEach((candidate) => {
    if (candidate === step) {
      setPipelineStageState(candidate, "active");
    } else if (candidate < step && pipelineStageStates[candidate] !== "done") {
      setPipelineStageState(candidate, "skipped");
    } else if (candidate > step) {
      setPipelineStageState(candidate, "pending");
    }
  });

  renderPipelineStatus(step);
  renderPipelineTrack();
}

/** Mark a stage complete. Only a real stage response calls this. */
function completePipelineStage(step, runId) {
  if (!isCurrentPipelineRun(runId)) return;
  setPipelineStageState(step, "done");
  if (pipelineSelectedStage === null) renderPipelineStatus(step, { done: true });
  renderPipelineTrack();
}

/** Render the persistent failure state for a terminated run. */
function showPipelineFailure(error, { stage = 1, runId, retry = retryPipelineRun } = {}) {
  if (!isCurrentPipelineRun(runId)) return;

  stopProgressTimer();
  cancelPipelineHideTimer();
  cancelPipelineMorph();
  setPipelineRunState("failed");
  setGenerationStageVisible(true);
  const progress = document.getElementById("pipeline-progress");
  if (progress) progress.classList.add("visible");
  const resultsView = document.getElementById("results-view");
  if (resultsView) resultsView.classList.remove("visible");
  document.body.classList.remove("results-fullscreen", "results-with-sidebar");

  setPipelineStageState(stage, "failed");
  [1, 2, 3].forEach((step) => {
    if (step > stage) setPipelineStageState(step, "pending");
  });
  pipelineActiveStage = stage;
  clearPipelineStageSelection();
  renderPipelineStatus(stage);
  renderPipelineTrack();

  const failure = classifyPipelineError(error);
  const panel = document.getElementById("pipeline-failure");
  const titleEl = document.getElementById("pipeline-failure-title");
  const messageEl = document.getElementById("pipeline-failure-message");
  const hintEl = document.getElementById("pipeline-failure-hint");
  const actionsEl = document.getElementById("pipeline-failure-actions");
  if (!panel || !titleEl || !messageEl || !actionsEl) return;

  panel.dataset.kind = failure.kind;
  // The stage is named in the panel too, so a failure reads as "this stage
  // stopped", never as an ambiguous whole-run outcome.
  titleEl.textContent = `${PIPELINE_STAGE_LABELS[stage]}: ${failure.title}`;
  messageEl.textContent = failure.message;
  if (hintEl) {
    const hint = failure.detail && failure.detail !== failure.message ? failure.detail : "";
    hintEl.textContent = hint;
    hintEl.hidden = !hint;
  }

  actionsEl.replaceChildren();
  // Only offer what can actually help: a blocked safety decision or an
  // exhausted allowance will not change on a bare retry.
  const actions = [
    failure.canUpgrade && { id: "upgrade", label: "View plans", variant: "primary", onClick: () => openPricingModal() },
    failure.canRetry && { id: "retry", label: "Retry", variant: failure.canUpgrade ? "secondary" : "primary", onClick: retry },
    failure.canEdit && { id: "edit", label: "Edit prompt", variant: "secondary", onClick: editPipelinePrompt },
  ].filter(Boolean);
  // A terminated run must always leave a way back to usable controls, even
  // when neither retrying nor editing can fix what happened.
  if (!failure.canEdit && !failure.canRetry) {
    actions.push({ id: "edit", label: "Back to prompt", variant: "secondary", onClick: editPipelinePrompt });
  }
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.dataset.action = action.id;
    button.dataset.variant = action.variant;
    button.addEventListener("click", action.onClick);
    actionsEl.appendChild(button);
  });

  panel.hidden = false;
  // A terminated run must leave a usable, focused control behind.
  const firstAction = actionsEl.querySelector("button");
  if (firstAction) firstAction.focus({ preventScroll: true });
}

/**
 * Return to the composer with the submitted prompt intact. Editing abandons
 * the in-flight run: its id is invalidated so a late response is discarded,
 * its request is cancelled, and the send control is usable again — the run
 * can never finish behind the composer's back and reopen Results.
 */
function editPipelinePrompt() {
  invalidatePipelineRun();
  abortPipelineRequests();
  pipelineState.isRunning = false;
  setRunPipelineButtonBusy(false);
  updateDeployButtonVisibility();
  setPipelineRunState("settled");
  cancelPipelineMorph();
  stopProgressTimer();
  cancelPipelineHideTimer();
  hidePipelineFailure();
  const progress = document.getElementById("pipeline-progress");
  if (progress) progress.classList.remove("visible");
  setGenerationStageVisible(false);
  const input = document.getElementById("pipeline-input");
  if (input) {
    if (pipelineState.submittedPrompt) input.value = pipelineState.submittedPrompt;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

/** Re-run the prompt and images the user submitted, unchanged. */
function retryPipelineRun() {
  const input = document.getElementById("pipeline-input");
  if (input && pipelineState.submittedPrompt) {
    input.value = pipelineState.submittedPrompt;
  }
  promptImages = pipelineState.submittedImages.slice();
  renderPromptImages();
  hidePipelineFailure();
  runThinkingPipeline();
}

function startProgressTimer() {
  stopProgressTimer();

  pipelineElapsedTimer = setInterval(() => {
    const elapsed = (Date.now() - pipelineStartTime) / 1000;
    const elapsedEl = document.getElementById("progress-elapsed");
    if (elapsedEl) elapsedEl.textContent = `${Math.floor(elapsed)}s`;
  }, 250);
}

function stopProgressTimer() {
  if (pipelineElapsedTimer) {
    clearInterval(pipelineElapsedTimer);
    pipelineElapsedTimer = null;
  }
}

// The settled run's panel lingers 400ms before it hides; a run that starts
// inside that window must not be blanked by the previous run's timer.
let pipelineHideTimer = null;

function cancelPipelineHideTimer() {
  if (pipelineHideTimer) {
    clearTimeout(pipelineHideTimer);
    pipelineHideTimer = null;
  }
}

function hidePipelineProgress() {
  stopProgressTimer();
  cancelPipelineHideTimer();
  setPipelineRunState("settled");
  renderPipelineTrack();

  const fillEl = document.getElementById("pipeline-progress-fill");

  // Brief pause then hide
  pipelineHideTimer = setTimeout(() => {
    pipelineHideTimer = null;
    const progress = document.getElementById("pipeline-progress");
    if (progress) progress.classList.remove("visible");
    if (fillEl) fillEl.style.width = "0%";
  }, 400);
}

function reviewStatusIcon(status, className = "") {
  const paths = {
    pass: `<path d="M20 6 9 17l-5-5"/>`,
    warning: `<path d="M12 9v4m0 4h.01"/><path d="M10.3 3.6 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/>`,
    fail: `<path d="m15 9-6 6m0-6 6 6"/><circle cx="12" cy="12" r="9"/>`,
    // Manual follow-up is information, not an alert - the triangle is reserved
    // for findings that actually stop the push.
    info: `<circle cx="12" cy="12" r="9"/><path d="M12 16v-4m0-4h.01"/>`,
  };
  return `<svg class="review-status-icon ${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[status] || paths.warning}</svg>`;
}

function reviewStatusLabel(status) {
  return {
    pass: "Passed review",
    warning: "Needs attention",
    fail: "Blocking issues",
  }[status] || "Needs attention";
}

function getReviewPresentation() {
  return buildReviewPresentation({
    bundle: pipelineState.artifactBundle,
    reviewResult: pipelineState.step3Result,
  });
}

function renderFinding(finding) {
  return `
    <div class="review-finding review-finding-${escapeAttr(finding.severity)}">
      ${reviewStatusIcon(finding.severity)}
      <div>
        <div class="review-finding-message">${escapeHtml(finding.message)}</div>
        ${finding.suggestion ? `<div class="review-finding-suggestion">${escapeHtml(finding.suggestion)}</div>` : ""}
        <span class="review-source">${escapeHtml(finding.source)}</span>
      </div>
    </div>
  `;
}

function renderManualStep(step) {
  return `
    <li class="manual-step">
      <div>
        <strong>${escapeHtml(step.title)}</strong>
        ${step.detail && step.detail !== step.title ? `<p>${escapeHtml(step.detail)}</p>` : ""}
      </div>
    </li>
  `;
}

function renderSummaryDetail(presentation) {
  const summaryDetail = document.getElementById("results-summary-detail");
  const resultsTitle = document.getElementById("results-title");
  if (!summaryDetail) return;
  if (resultsTitle) {
    resultsTitle.textContent = presentation.title;
  }

  const score = presentation.score;
  const scoreTone = score == null
    ? "neutral"
    : score >= 80 ? "pass" : score >= 60 ? "warning" : "fail";
  const scoreLabel = score == null
    ? ""
    : score >= 80 ? "Strong" : score >= 60 ? "Needs work" : "High risk";
  const findings = presentation.findings.length
    ? `
      <ul class="summary-findings">
        ${presentation.findings.map((finding) => `
          <li class="summary-finding-${escapeAttr(finding.severity)}">
            ${reviewStatusIcon(finding.severity)}
            <span>
              <strong>${escapeHtml(finding.message)}</strong>
              ${finding.suggestion ? `<small>${escapeHtml(finding.suggestion)}</small>` : ""}
            </span>
          </li>
        `).join("")}
      </ul>
    `
    : "";
  // Bundle-level warnings (deploy ordering, compatibility findings) belong on
  // the summary surface as a distinct class of message. They are NOT
  // per-file issues and must never leak into a selected artifact's review.
  const bundleWarnings = presentation.warnings.length
    ? `
      <section class="summary-bundle-warnings" aria-label="Bundle warnings">
        <h4>${reviewStatusIcon("warning")} Bundle</h4>
        <ul>
          ${presentation.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}
        </ul>
      </section>
    `
    : "";
  const manualSteps = presentation.manualSteps.length
    ? `
      <section class="summary-manual-callout">
        <h3>${reviewStatusIcon("info")} Complete in FlutterFlow</h3>
        <p class="summary-manual-lead">For your information — these don't block the deploy. Finish them by hand in the FlutterFlow editor once the code is pushed.</p>
        <ul>
          ${presentation.manualSteps.map((step) => `
            <li>
              <strong>${escapeHtml(step.title)}</strong>
              ${step.detail && step.detail !== step.title ? `<span>${escapeHtml(step.detail)}</span>` : ""}
            </li>
          `).join("")}
        </ul>
      </section>
    `
    : "";

  summaryDetail.innerHTML = `
    <section class="review-summary">
      <div class="review-summary-copy">
        <p class="review-summary-text">${escapeHtml(presentation.summary)}</p>
        ${findings}
        ${bundleWarnings}
        ${manualSteps}
      </div>
      <div class="review-score-column">
        <aside class="review-score review-score-${escapeAttr(scoreTone)}" aria-label="${score == null ? "Review not scored" : `Review score ${score} out of 100`}">
          <span class="review-score-label">Score</span>
          <strong>${score == null ? "—" : escapeHtml(score)}</strong>
          <span class="review-score-total">${score == null ? "Not scored" : "out of 100"}</span>
          ${scoreLabel ? `<span class="review-score-status">${escapeHtml(scoreLabel)}</span>` : ""}
        </aside>
        <div class="review-score-feedback">
          <span>Is the generated code correct?</span>
          <div class="review-score-feedback-controls">
            <button type="button" class="feedback-btn" id="btn-feedback-up" aria-label="Yes, the generated code is correct" aria-pressed="false" onclick="submitResultsFeedback('up')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/></svg>
            </button>
            <button type="button" class="feedback-btn" id="btn-feedback-down" aria-label="No, the generated code is not correct" aria-pressed="false" onclick="submitResultsFeedback('down')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z"/></svg>
            </button>
          </div>
          <span id="results-feedback-status" class="sr-only" aria-live="polite"></span>
        </div>
      </div>
    </section>
  `;
}

function renderSelectedArtifactReview(presentation) {
  const selectedArtifact = presentation.artifacts.find(
    (artifact) => artifact.id === pipelineState.selectedArtifactId,
  ) || presentation.artifacts[0];
  if (!selectedArtifact) return "";

  const emptyFindingState = {
    pass: {
      icon: "pass",
      message: "No file-specific issues were found.",
    },
    warning: {
      icon: "warning",
      message: "This file needs attention, but Code Review did not return a specific finding.",
    },
    fail: {
      icon: "fail",
      message: "This file is blocked, but Code Review did not return a specific finding.",
    },
  }[selectedArtifact.status];
  const findings = selectedArtifact.findings.length
    ? selectedArtifact.findings.map(renderFinding).join("")
    : `<div class="review-empty-state review-empty-${escapeAttr(selectedArtifact.status)}">${reviewStatusIcon(emptyFindingState.icon)} ${escapeHtml(emptyFindingState.message)}</div>`;
  const dependencies = selectedArtifact.dependencies?.length
    ? selectedArtifact.dependencies.map((dependency) => `
      <li><code>${escapeHtml(dependency.name)}${dependency.version ? ` ${escapeHtml(dependency.version)}` : ""}</code>${dependency.reason ? `<p>${escapeHtml(dependency.reason)}</p>` : ""}</li>
    `).join("")
    : `<li class="review-muted">No external packages</li>`;
  const imports = selectedArtifact.imports?.length
    ? selectedArtifact.imports.map((item) => `<code>${escapeHtml(item)}</code>`).join("")
    : `<span class="review-muted">No imports returned</span>`;
  const publicApi = selectedArtifact.publicApi?.length
    ? selectedArtifact.publicApi.map((item) => `<code>${escapeHtml(item)}</code>`).join("")
    : `<span class="review-muted">No public API signature returned</span>`;
  const relationships = selectedArtifact.relationships.length
    ? selectedArtifact.relationships.map((relationship) => `
      <li><strong>${escapeHtml(relationship.from || "Bundle")}</strong> ${escapeHtml(relationship.type)} <strong>${escapeHtml(relationship.to || "Bundle")}</strong>${relationship.description ? `<p>${escapeHtml(relationship.description)}</p>` : ""}</li>
    `).join("")
    : `<li class="review-muted">No relationships for this file</li>`;

  return `
    <div class="file-review-header file-review-${selectedArtifact.status}">
      <div>
        <span class="file-review-status">${reviewStatusIcon(selectedArtifact.status)} ${escapeHtml(reviewStatusLabel(selectedArtifact.status))}</span>
        <h3>${escapeHtml(selectedArtifact.artifactName)}</h3>
        ${selectedArtifact.description ? `<p>${escapeHtml(selectedArtifact.description)}</p>` : ""}
      </div>
      <div class="file-review-meta">
        <span>${escapeHtml(selectedArtifact.artifactType)}</span>
        <span>${escapeHtml(selectedArtifact.fileName)}</span>
      </div>
    </div>
    <section class="file-review-section">
      <h4>Code Review findings</h4>
      ${findings}
    </section>
    ${selectedArtifact.manualSteps.length ? `
      <section class="file-review-section file-manual-section">
        <h4>Manual FlutterFlow steps for this file</h4>
        <ol>${selectedArtifact.manualSteps.map(renderManualStep).join("")}</ol>
      </section>
    ` : ""}
    <details class="file-technical-details">
      <summary>File details</summary>
      <div class="file-detail-grid">
        <section class="file-review-section">
          <h4>Dependencies</h4>
          <ul class="dependency-list">${dependencies}</ul>
        </section>
        <section class="file-review-section">
          <h4>Deployment</h4>
          <dl class="file-deploy-facts">
            <div><dt>Status</dt><dd>${escapeHtml(selectedArtifact.deployStatus || "pending")}</dd></div>
            <div><dt>Order</dt><dd>${selectedArtifact.index + 1} of ${presentation.artifacts.length}</dd></div>
            <div><dt>Path hint</dt><dd>${escapeHtml(selectedArtifact.pathHint || "Not returned")}</dd></div>
          </dl>
        </section>
      </div>
      <section class="file-review-section">
        <h4>Public API</h4>
        <div class="code-chip-list">${publicApi}</div>
      </section>
      <section class="file-review-section">
        <h4>Imports</h4>
        <div class="code-chip-list">${imports}</div>
      </section>
      <section class="file-review-section">
        <h4>Relationships</h4>
        <ul class="file-relationship-list">${relationships}</ul>
      </section>
    </details>
  `;
}

function renderBundleControls(presentation) {
  const strip = document.getElementById("bundle-strip");
  const summaryTab = document.getElementById("results-summary-tab");
  const tabs = document.getElementById("artifact-tabs");
  const count = document.getElementById("results-file-count");
  if (summaryTab) {
    const isSummary = pipelineState.resultsViewMode === "summary";
    summaryTab.classList.toggle("active", isSummary);
    summaryTab.setAttribute("role", "tab");
    summaryTab.setAttribute("aria-selected", String(isSummary));
    summaryTab.setAttribute("aria-controls", "results-summary-detail");
    summaryTab.tabIndex = isSummary ? 0 : -1;
  }
  if (tabs) {
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Artifacts in this bundle");
  }
  if (!presentation.artifacts.length) {
    if (count) count.textContent = "0 files";
    if (strip) strip.classList.remove("visible");
    if (tabs) tabs.innerHTML = "";
    ensureResultsTabKeyboard();
    return;
  }

  if (count) {
    const fileCount = presentation.artifacts.length;
    count.textContent = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  }
  if (tabs) {
    tabs.innerHTML = presentation.artifacts.map((artifact) => {
      const isSelected = pipelineState.resultsViewMode === "file"
        && artifact.id === pipelineState.selectedArtifactId;
      return `
      <button
        type="button"
        id="artifact-tab-${escapeAttr(artifact.id)}"
        role="tab"
        aria-selected="${isSelected ? "true" : "false"}"
        aria-controls="artifact-results-split"
        class="artifact-tab${isSelected ? " active" : ""}"
        data-artifact-id="${escapeAttr(artifact.id)}"
        tabindex="${isSelected ? 0 : -1}"
        title="${escapeAttr(`${reviewStatusLabel(artifact.status)} · ${artifact.fileName || artifact.artifactName}`)}"
      >
        <span class="artifact-tab-status status-${escapeAttr(artifact.status)}">${reviewStatusIcon(artifact.status)}</span>
        <span>
          <span class="artifact-tab-name">${escapeHtml(artifact.artifactName)}</span>
          <span class="artifact-tab-meta">${escapeHtml(artifact.artifactType)}</span>
        </span>
      </button>
    `;
    }).join("");
    tabs.onclick = (event) => {
      const tab = event.target.closest(".artifact-tab");
      if (tab?.dataset?.artifactId) {
        selectArtifact(tab.dataset.artifactId);
      }
    };
    ensureResultsTabKeyboard();
  }

  if (strip) strip.classList.add("visible");
}

// WAI-ARIA tabs pattern: ArrowRight/ArrowLeft move focus through the tablist,
// Home/End jump to the first/last tab. The selected tab is activated and focus
// is re-applied after the render so keyboard focus survives the re-render that
// refreshArtifactTabs performs on selection change.
function ensureResultsTabKeyboard() {
  const tablist = document.getElementById("bundle-strip");
  if (!tablist || tablist.dataset.tabKeyboard === "bound") return;
  tablist.dataset.tabKeyboard = "bound";
  tablist.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const tabs = [
      document.getElementById("results-summary-tab"),
      ...Array.from(document.querySelectorAll("#artifact-tabs .artifact-tab")),
    ].filter(Boolean);
    if (!tabs.length || !tabs.includes(document.activeElement)) return;

    let targetIndex = -1;
    const currentIndex = tabs.indexOf(document.activeElement);
    if (event.key === "ArrowRight") targetIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    const target = tabs[targetIndex];
    if (!target) return;
    if (target.id === "results-summary-tab") {
      selectResultsSummary();
    } else {
      const artifactId = target.dataset.artifactId;
      if (artifactId) selectArtifact(artifactId);
    }
    // Re-apply focus to the freshly rendered tab after the selection re-render.
    const freshTab = target.id === "results-summary-tab"
      ? document.getElementById("results-summary-tab")
      : document.querySelector(`#artifact-tabs .artifact-tab[data-artifact-id="${target.dataset.artifactId}"]`);
    if (freshTab) freshTab.focus();
  });
}

function updateSelectedArtifactPanels() {
  document.body.classList.add("results-fullscreen");
  document.body.classList.add("results-with-sidebar");
  const resultsView = document.getElementById("results-view");
  const codeOutput = document.getElementById("results-code-output");
  const auditOutput = document.getElementById("results-audit-output");
  const summaryDetail = document.getElementById("results-summary-detail");
  const artifactSplit = document.getElementById("artifact-results-split");
  const presentation = getReviewPresentation();
  const selectedCode = getSelectedArtifactCode();

  // Harden the summary/file tabpanel semantics for the WAI-ARIA tabs pattern.
  if (summaryDetail) {
    summaryDetail.setAttribute("role", "tabpanel");
    summaryDetail.setAttribute("aria-labelledby", "results-summary-tab");
  }
  if (artifactSplit) {
    artifactSplit.setAttribute("role", "tabpanel");
    const selectedArtifact = presentation?.artifacts?.find(
      (artifact) => artifact.id === pipelineState.selectedArtifactId,
    );
    artifactSplit.setAttribute(
      "aria-labelledby",
      selectedArtifact ? `artifact-tab-${selectedArtifact.id}` : "results-summary-tab",
    );
  }

  renderSummaryDetail(presentation);
  renderBundleControls(presentation);

  if (codeOutput) codeOutput.textContent = "";
  if (codeOutput) {
    const highlighted = highlightCode(selectedCode);
    codeOutput.innerHTML = highlighted; // eslint-disable-line -- highlight.js output
  }
  if (auditOutput) {
    auditOutput.innerHTML = renderSelectedArtifactReview(presentation);
  }
  if (summaryDetail) {
    summaryDetail.classList.toggle("hidden", pipelineState.resultsViewMode !== "summary");
  }
  if (artifactSplit) {
    artifactSplit.classList.toggle("hidden", pipelineState.resultsViewMode !== "file");
  }
  if (resultsView) resultsView.classList.add("visible");
}

function showResultsView(codeContent, auditContent) {
  setGenerationStageVisible(true);
  if (!pipelineState.selectedArtifactId) {
    pipelineState.selectedArtifactId = getPrimaryArtifact(pipelineState.artifactBundle).id;
  }
  pipelineState.resultsViewMode = "summary";
  document.body.classList.add("results-fullscreen");
  const legacyReviewOutput = document.getElementById("step3-output");
  if (legacyReviewOutput) legacyReviewOutput.textContent = "";
  updateSelectedArtifactPanels();
  updateDeployButtonVisibility();

  // Reset feedback state for the CURRENT generation: a new run must never
  // carry a prior vote (visual, aria-pressed, pending lock or status) into
  // code the user has not yet reviewed.
  resetResultsFeedbackState();
}

function resetResultsFeedbackState() {
  const upBtn = document.getElementById("btn-feedback-up");
  const downBtn = document.getElementById("btn-feedback-down");
  const statusEl = document.getElementById("results-feedback-status");
  if (upBtn) {
    upBtn.className = "feedback-btn";
    upBtn.setAttribute("aria-pressed", "false");
    upBtn.disabled = false;
    upBtn.removeAttribute("aria-disabled");
  }
  if (downBtn) {
    downBtn.className = "feedback-btn";
    downBtn.setAttribute("aria-pressed", "false");
    downBtn.disabled = false;
    downBtn.removeAttribute("aria-disabled");
  }
  if (statusEl) {
    statusEl.textContent = "";
  }
  resultsFeedbackPending = false;
}

function showDebugMultiArtifactResults() {
  pipelineState.step1Result = JSON.stringify({
    schemaVersion: "artifact-bundle/v1",
    id: "debug-agent-ui",
    title: "Debug Agent UI",
    artifacts: [
      {
        id: "custom-class-agent-event",
        artifactType: "CustomClass",
        artifactName: "AgentEvent",
        fileName: "agent_event.dart",
        description: "Data model for agent events.",
      },
      {
        id: "custom-widget-agent-timeline",
        artifactType: "CustomWidget",
        artifactName: "AgentTimeline",
        fileName: "agent_timeline.dart",
        description: "Widget for rendering chronological agent events.",
      },
    ],
    relationships: [
      {
        from: "custom-widget-agent-timeline",
        to: "custom-class-agent-event",
        type: "imports",
      },
    ],
    deployOrder: ["custom-class-agent-event", "custom-widget-agent-timeline"],
  });
  updateBundleSpecFromArchitectResult();
  pipelineState.step2Result = JSON.stringify({
    schemaVersion: "artifact-bundle/v1",
    id: "debug-agent-ui",
    title: "Debug Agent UI",
    artifacts: [
      {
        id: "custom-class-agent-event",
        artifactType: "CustomClass",
        artifactName: "AgentEvent",
        fileName: "agent_event.dart",
        code: "class AgentEvent {\n  const AgentEvent({required this.id, required this.label});\n  final String id;\n  final String label;\n}\n",
      },
      {
        id: "custom-widget-agent-timeline",
        artifactType: "CustomWidget",
        artifactName: "AgentTimeline",
        fileName: "agent_timeline.dart",
        code: "class AgentTimeline extends StatelessWidget {\n  const AgentTimeline({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return const SizedBox.shrink();\n  }\n}\n",
      },
    ],
    relationships: [
      {
        from: "custom-widget-agent-timeline",
        to: "custom-class-agent-event",
        type: "imports",
      },
    ],
    deployOrder: ["custom-class-agent-event", "custom-widget-agent-timeline"],
  });
  updateArtifactBundleFromGeneratedCode();
  pipelineState.step3Result = JSON.stringify({
    schemaVersion: "artifact-bundle/v1",
    id: "debug-agent-ui",
    overallReview: {
      status: "warn",
      score: 86,
      summary: "The bundle structure is sound. AgentTimeline still needs its event rendering completed before release.",
      manualActions: [
        {
          title: "Wire the generated AgentTimeline into the target page",
          detail: "Add the custom widget in FlutterFlow and bind its event data.",
          location: "UI Builder > Custom Widgets",
          timing: "after deploy",
        },
      ],
    },
    artifacts: [
      {
        id: "custom-class-agent-event",
        artifactName: "AgentEvent",
        artifactType: "CustomClass",
        review: { status: "pass", findings: [] },
      },
      {
        id: "custom-widget-agent-timeline",
        artifactName: "AgentTimeline",
        artifactType: "CustomWidget",
        review: {
          status: "warn",
          findings: [
            {
              severity: "warning",
              message: "Widget is a placeholder.",
              suggestion: "Render the event collection before shipping.",
            },
          ],
        },
      },
    ],
  });
  updateBundleReviewFromReviewResult();
  dismissWelcomeVideo();
  const paywallEl = document.getElementById("paywall-exhausted");
  if (paywallEl) paywallEl.classList.add("hidden");
  const walkthroughModal = document.getElementById("walkthrough-modal");
  if (walkthroughModal) closeModal(walkthroughModal, { restoreFocus: false });
  const readyState = document.getElementById("ready-state");
  if (readyState) readyState.classList.add("hidden");
  const stageContainer = document.getElementById("main-stage-container");
  if (stageContainer) stageContainer.classList.add("visible");
  hidePipelineProgress();
  showResultsView(getSelectedArtifactCode(), renderMarkdownAudit(pipelineState.step3Result));
}

function selectArtifact(artifactId) {
  pipelineState.selectedArtifactId = artifactId;
  pipelineState.resultsViewMode = "file";
  updateSelectedArtifactPanels();
}

function selectResultsSummary() {
  pipelineState.resultsViewMode = "summary";
  updateSelectedArtifactPanels();
}

// Test/diagnostic hook used by the browser suite to render an arbitrary
// bundle + review without running paid generation. Mirrors the debug path so
// the Results Summary / artifact inspection surfaces can be asserted in
// isolation. Gated on import.meta.env.DEV so the hook (and its ability to
// force the results view with arbitrary content) is tree-shaken out of the
// production bundle: it exists only under the Vite dev server, which is what
// the Playwright suite runs against.
if (import.meta.env.DEV) {
  function renderResultsPreview(bundle, review) {
    const readyState = document.getElementById("ready-state");
    if (readyState) readyState.classList.add("hidden");
    const stageContainer = document.getElementById("main-stage-container");
    if (stageContainer) stageContainer.classList.add("visible");
    hidePipelineProgress?.();
    const paywallEl = document.getElementById("paywall-exhausted");
    if (paywallEl) paywallEl.classList.add("hidden");

    pipelineState.step3Result = typeof review === "string" ? review : JSON.stringify(review);
    pipelineState.step2Result = typeof bundle === "string" ? bundle : JSON.stringify(bundle);
    pipelineState.artifactBundle = normalizeArtifactBundle(bundle, {
      id: bundle?.id,
      title: bundle?.title,
      description: bundle?.description,
    });
    pipelineState.bundleSpec = pipelineState.artifactBundle;
    updateBundleReviewFromReviewResult();
    pipelineState.selectedArtifactId = getPrimaryArtifact(pipelineState.artifactBundle).id;
    showResultsView(getSelectedArtifactCode(), renderMarkdownAudit(pipelineState.step3Result));
  }
  window.__CCC_RENDER_RESULTS__ = renderResultsPreview;

  // Deterministic test hook for STU-380: drives the exact same terminal
  // presentation the real confirm flow uses, against a fixture result, so the
  // browser suite can assert truthful outcomes without a real remote write.
  window.__CCC_RENDER_DEPLOY_TERMINAL__ = renderCommitTerminal;
  // Lets the browser suite start a live deploy progress overlay so it can
  // prove a terminal state releases the busy state.
  window.__CCC_START_DEPLOY_PROGRESS__ = () =>
    commitProgress.start({ withProvisioning: true });
  // Lets the browser suite put the deploy into (and out of) its exactly-real
  // busied state — the same `setDeployBusy` the confirm flow calls — so a test
  // can prove a terminal outcome releases the busy lock on the deploy controls.
  window.__CCC_SET_DEPLOY_BUSY__ = setDeployBusy;
  // Lets the browser suite open the real commit-confirm modal (and set real
  // `pendingCommitData`) with fixture code, so the duplicate-submit guard in
  // `confirmCommitToFlutterFlow` can be driven through the real confirm flow
  // without a real remote write.
  window.__CCC_OPEN_COMMIT_CONFIRM__ = (codeInfo, checks, deps) =>
    openCommitConfirmModal(
      {
        fileName: "gauge_widget.dart",
        artifactType: "CustomClass",
        content: "class GaugeWidget {}",
        ...codeInfo,
      },
      { warnings: [], ...checks },
      deps || {},
    );
}

function copyResultsCode() {
  const btn = document.getElementById("btn-copy-results");
  const statusEl = document.getElementById("results-copy-status");
  const rawCode = getSelectedArtifactCode();
  const setStatus = (message, ok) => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle("ok", Boolean(ok));
    statusEl.classList.toggle("fail", !ok);
  };

  if (!navigator.clipboard?.writeText) {
    // The Clipboard API is unavailable (non-secure context or unsupported).
    // Surface a non-blocking notice; the results view stays usable.
    setStatus("Copying isn't supported in this browser.", false);
    return;
  }

  navigator.clipboard.writeText(rawCode).then(() => {
    setStatus("Copied to clipboard", true);
    if (btn) {
      btn.classList.add("copied");
      const label = btn.querySelector("span");
      if (label) {
        const origText = label.textContent;
        label.textContent = "Copied!";
        setTimeout(() => {
          btn.classList.remove("copied");
          label.textContent = origText;
        }, 2000);
      }
    }
  }).catch(() => {
    // Permission denied or transient clipboard failure. This must never block
    // the results view — the user can still read and select the code.
    setStatus("Clipboard permission was denied. Select the code to copy it manually.", false);
  });
}

let resultsFeedbackPending = false;

async function submitResultsFeedback(direction) {
  const upBtn = document.getElementById("btn-feedback-up");
  const downBtn = document.getElementById("btn-feedback-down");
  const statusEl = document.getElementById("results-feedback-status");
  if (!upBtn || !downBtn) return;
  // Ignore a rapid double-click (or a second direction) while a submission is
  // still in flight so we never send a duplicate vote for the same generation.
  if (resultsFeedbackPending) return;

  const announce = (message) => {
    if (!statusEl) return;
    statusEl.textContent = "";
    void statusEl.offsetWidth; // force reflow so repeated announcements re-fire
    statusEl.textContent = message;
  };

  const setPending = (pending) => {
    resultsFeedbackPending = pending;
    [upBtn, downBtn].forEach((btn) => {
      btn.disabled = pending;
      btn.setAttribute("aria-disabled", String(pending));
    });
  };

  const feedbackType = direction === "up" ? "thumbsUp" : "thumbsDown";
  setPending(true);
  announce("Submitting review feedback…");

  // Capture the CURRENT generation up front so a retry always sends the exact
  // bundle + input the user reviewed — never a prior generation's payload.
  const payload = { type: feedbackType, code: pipelineState.step2Result, input: pipelineState.step1Result };
  try {
    const result = await callEndpoint(payload.type, payload.code, payload.input);
    // A vote is only claimed as saved after the endpoint positively confirms
    // success. Requiring the explicit `success: true` the backend contract
    // returns means a 2xx carrying an error-shaped body ({"error":"quota
    // exceeded"} or {"ok":false}, with no truthy success field) is never
    // announced as saved — a failed submission must stay retry-able instead
    // of silently clearing the pending lock.
    if (!result || result.success !== true) {
      // A non-2xx response, network failure, or unconfirmed 2xx is never shown
      // as saved.
      setPending(false);
      announce("Review feedback could not be sent. Tap again to retry.");
      return;
    }

    // Only a confirmed submission marks the vote saved; the chosen direction
    // becomes pressed and the other is cleared (mutually exclusive).
    upBtn.classList.toggle("active-up", direction === "up");
    downBtn.classList.toggle("active-down", direction === "down");
    upBtn.setAttribute("aria-pressed", String(direction === "up"));
    downBtn.setAttribute("aria-pressed", String(direction === "down"));
    setPending(false);
    announce("Review feedback saved.");
    trackEvent("Generation Feedback", { feedback: feedbackType });
  } catch (error) {
    // callEndpoint swallows its own/rejection errors into { success:false },
    // but a hard throw must also fail open without showing a saved vote.
    setPending(false);
    announce("Review feedback could not be sent. Tap again to retry.");
  }
}

function showErrorInputPanel() {
  const panel = document.getElementById("error-input-panel");
  if (panel) {
    panel.classList.remove("hidden");
    panel.style.display = "flex";
    const input = document.getElementById("ff-error-paste-input");
    if (input) setTimeout(() => input.focus(), 100);
  }
}

function hideErrorInputPanel() {
  const panel = document.getElementById("error-input-panel");
  if (panel) {
    panel.classList.add("hidden");
    panel.style.display = "none";
  }
}

// --- VIEW ROUTER & SHELL UI (STU-375) ---

function setGenerationStageVisible(visible) {
  const stage = document.getElementById("generation-stage");
  if (!stage) return;
  if (visible) {
    stage.hidden = false;
    stage.inert = false;
    requestAnimationFrame(() => stage.classList.add("is-active"));
  } else {
    stage.classList.remove("is-active");
    stage.inert = true;
    setTimeout(() => {
      if (!stage.classList.contains("is-active")) stage.hidden = true;
    }, 260);
  }
}

function updateShellUI() {
  const signedIn = authState.isVerified && !!authState.email;
  const tier = subscriptionState.tier || "free";
  const loading = signedIn && isSubscriptionLoading();
  const resolved = !signedIn || isSubscriptionResolved();

  const labels = planLabels;
  const planLabel = loading ? "Checking…" : resolved ? labels[tier] || "Free" : "—";

  const topbarPlan = document.getElementById("topbar-plan");
  if (topbarPlan) topbarPlan.textContent = planLabel;

  const avatar = document.getElementById("topbar-avatar");
  if (avatar) avatar.textContent = (authState.email || "?")[0].toUpperCase();

  renderUsageSurfaces();

  // Plans view current-plan indicators
  const freeCurrent = document.getElementById("plans-free-current");
  if (freeCurrent) freeCurrent.classList.toggle("hidden", tier !== "free" || !resolved);

  const proBtn = document.getElementById("plans-checkout-btn-professional");
  if (proBtn) {
    const isCurrent = tier === "professional" && resolved;
    proBtn.disabled = isCurrent;
    proBtn.textContent = isCurrent ? "Current plan" : "Subscribe";
  }
  const powerBtn = document.getElementById("plans-checkout-btn-power");
  if (powerBtn) {
    const isCurrent = tier === "power" && resolved;
    powerBtn.disabled = isCurrent;
    powerBtn.textContent = isCurrent ? "Current plan" : "Subscribe";
  }
}

function openCreditsModal() {
  updateShellUI();
  const modal = document.getElementById("credits-modal");
  if (modal) openModal(modal);
}

function closeCreditsModal(event) {
  if (event && event.target !== event.currentTarget) return;
  const modal = document.getElementById("credits-modal");
  if (modal) closeModal(modal);
}

function switchView(view, pushState = true, moveFocus = true) {
  view = ["home", "account", "plans"].includes(view) ? view : "home";
  const views = document.querySelectorAll(".view[data-view]");
  views.forEach((el) => {
    const isTarget = el.dataset.view === view;
    if (isTarget) {
      el.hidden = false;
      el.removeAttribute("inert");
      requestAnimationFrame(() => {
        el.classList.add("is-active");
        // Land keyboard focus in the revealed surface once it is visible.
        if (moveFocus) el.focus({ preventScroll: true });
      });
    } else {
      el.classList.remove("is-active");
      el.setAttribute("inert", "true");
      setTimeout(() => {
        if (!el.classList.contains("is-active")) el.hidden = true;
      }, 260);
    }
  });

  // Generation overlay only belongs to the home surface.
  if (view !== "home") setGenerationStageVisible(false);
  else {
    const stage = document.getElementById("main-stage-container");
    if (stage && stage.classList.contains("visible")) setGenerationStageVisible(true);
  }

  document.querySelectorAll(".nav-link[data-view]").forEach((link) => {
    const active = link.dataset.view === view;
    link.setAttribute("aria-current", active ? "page" : null);
    if (!active) link.removeAttribute("aria-current");
  });

  if (pushState) {
    const hash = view === "home" ? "" : `#${view}`;
    if (window.location.hash !== hash) window.history.pushState({ view }, "", hash || "#");
  }
}

let hasRestoredInitialView = false;
function restoreViewFromHash() {
  const raw = window.location.hash.replace(/^#/, "");
  // The first restore is the initial page load, so focus stays wherever the
  // browser put it; every later hash change is user-driven navigation and
  // may move focus into the revealed surface.
  switchView(raw || "home", false, hasRestoredInitialView);
  hasRestoredInitialView = true;
}

window.addEventListener("popstate", (event) => {
  restoreViewFromHash();
});

window.addEventListener("hashchange", () => {
  restoreViewFromHash();
});

function bindHeroChips() {
  const chips = document.querySelectorAll("#example-chips .chip");
  const input = document.getElementById("pipeline-input");
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      if (input) input.value = chip.dataset.prompt || "";
      input?.focus();
    });
  });
}

window.copyResultsCode = copyResultsCode;
window.selectArtifact = selectArtifact;
window.selectResultsSummary = selectResultsSummary;
window.submitResultsFeedback = submitResultsFeedback;
window.showErrorInputPanel = showErrorInputPanel;
window.hideErrorInputPanel = hideErrorInputPanel;
window.setGenerationStageVisible = setGenerationStageVisible;
window.switchView = switchView;
// Pipeline view controls used by the generation panel's inline handlers.
window.selectPipelineStage = selectPipelineStage;
window.editPipelinePrompt = editPipelinePrompt;
window.retryPipelineRun = retryPipelineRun;
window.openCreditsModal = openCreditsModal;
window.closeCreditsModal = closeCreditsModal;
