// Shared contract with the backend magic-link workflow: domains, response
// codes and message wording all come from this fixture so the frontend guard
// cannot silently drift from the server.
import fixtures from './authMagicLinkFixtures.json' with { type: 'json' };

const ALLOWLISTED_DOMAINS = new Set(fixtures.allowlistedDomains);

export const MAGIC_LINK_SUCCESS_CODE = fixtures.successCode;
export const PLUS_ALIAS_REJECTED_CODE = fixtures.validationCode;

export function trimEmail(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function isKnownProviderPlusAlias(rawEmail) {
  const email = trimEmail(rawEmail);
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (!ALLOWLISTED_DOMAINS.has(domain)) return false;
  return local.includes('+');
}

function renderRejectionMessage(email, domain) {
  return fixtures.messageTemplate
    .replaceAll('{email}', email)
    .replaceAll('{domain}', domain);
}

export function explainPlusAliasRule(rawEmail) {
  if (!isKnownProviderPlusAlias(rawEmail)) return null;
  const email = trimEmail(rawEmail);
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1).toLowerCase();
  return renderRejectionMessage(email, domain);
}

/**
 * A magic-link send is only successful when the server says so: an explicit
 * `success: true`, the success code, or a legacy response that carries no code
 * and no failure field. An explicit `success: false` or a truthy `error` is
 * never a success, with or without a code, and an empty or malformed body is
 * not success-shaped either. Any other code — including the plus-alias
 * rejection — is an error, even though the HTTP request itself succeeded.
 */
export function isMagicLinkSuccess(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.success === false || data.error) return false;
  if (data.code) return data.code === MAGIC_LINK_SUCCESS_CODE;
  // Legacy code-less response: only an explicit success or the legacy
  // message-only shape counts.
  return data.success === true || typeof data.message === 'string';
}

export function getMagicLinkResultMessage(data, email) {
  if (data?.code === PLUS_ALIAS_REJECTED_CODE) {
    return data.message || explainPlusAliasRule(email) || 'Please enter your primary email address.';
  }
  if (isMagicLinkSuccess(data)) {
    return `Check your email — we sent a link to ${trimEmail(email)}`;
  }
  return data?.message || 'Something went wrong. Please try again.';
}
