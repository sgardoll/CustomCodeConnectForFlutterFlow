const ALLOWLISTED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com'
]);

export const MAGIC_LINK_SUCCESS_CODE = 'MAGIC_LINK_SENT';
export const PLUS_ALIAS_REJECTED_CODE = 'PLUS_ALIAS_REJECTED';

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

export function explainPlusAliasRule(rawEmail) {
  if (!isKnownProviderPlusAlias(rawEmail)) return null;
  const email = trimEmail(rawEmail);
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1).toLowerCase();
  return `Please enter your primary email address. Plus aliases (such as ${email}) are not allowed for ${domain} accounts.`;
}

export function getMagicLinkResultMessage(data, email) {
  if (data?.code === PLUS_ALIAS_REJECTED_CODE) {
    return data.message || explainPlusAliasRule(email) || 'Please enter your primary email address.';
  }
  if (data?.code === MAGIC_LINK_SUCCESS_CODE || !data?.code) {
    return `Check your email — we sent a link to ${trimEmail(email)}`;
  }
  return data.message || 'Something went wrong. Please try again.';
}
