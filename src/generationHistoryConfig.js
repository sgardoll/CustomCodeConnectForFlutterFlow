/** Public URLs only. No implicit production fallback, including in staging. */
export function resolveGenerationHistoryEndpoint({ target, stagingEndpoint, productionEndpoint } = {}) {
  if (!['staging', 'production'].includes(target)) throw new Error('Explicit history target required');
  const value = target === 'staging' ? stagingEndpoint : productionEndpoint;
  const url = new URL(value);
  const path = target === 'staging' ? '/staging/service/generation-history' : '/service/generation-history';
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== path) {
    throw new Error('Invalid public history endpoint for target');
  }
  return url.href;
}
