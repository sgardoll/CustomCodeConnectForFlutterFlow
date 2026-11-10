// Account generation credentials are never persisted or used to authenticate history.
export function createGenerationSessionClient({ endpoint, getSession, getLegacyToken, fetchImpl = fetch }) {
  let epoch = 0;
  let pending = null;
  const stale = () => new DOMException('Account session changed', 'AbortError');
  function invalidate() {
    epoch++;
    pending?.controller.abort();
    pending = null;
  }
  async function ensure() {
    const session = getSession();
    if (!session?.token || !session?.key) throw new Error('Sign in to prepare generation.');
    if (pending?.token === session.token && pending.key === session.key) return pending.promise;
    invalidate();
    const currentEpoch = epoch;
    const controller = new AbortController();
    const current = () => {
      const now = getSession();
      return epoch === currentEpoch && now?.token === session.token && now?.key === session.key;
    };
    const task = { token: session.token, key: session.key, controller };
    task.promise = (async () => {
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const identityToken = await getLegacyToken();
        if (!current()) throw stale();
        const response = await fetchImpl(endpoint, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken: session.token, ...(identityToken ? { identityToken } : {}) }),
        });
        if (!current()) throw stale();
        if (!response.ok) throw new Error('Account generation access could not be prepared. Please retry.');
        const data = await response.json();
        if (!current()) throw stale();
        if (typeof data?.user_id !== 'string' || !data.user_id || typeof data.identity_token !== 'string' || !data.identity_token) {
          throw new Error('Invalid account generation session.');
        }
        return { userId: data.user_id, token: data.identity_token };
      } finally {
        clearTimeout(timer);
        if (pending === task) pending = null;
      }
    })();
    pending = task;
    return task.promise;
  }
  return { ensure, invalidate };
}
