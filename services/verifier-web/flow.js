// Small guards for the page's request flow, kept out of app.js so they can be
// tested without a browser.

/**
 * fetch + JSON, never rejecting: a network error is status 0, so callers always
 * reach the code that re-enables controls and tells the user.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{status: number, body: any}>}
 */
export async function request(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return { status: 0, body: {} };
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/**
 * Whether a poll answer may still change the page: only while the session it
 * was asked about is the one being waited on. A late answer after Cancel (or
 * after a new check started) is dropped.
 *
 * @param {{view: string, sessionId: string|null}} state
 * @param {string} polledId
 */
export function pollStillCurrent(state, polledId) {
  return state.view === 'waiting' && state.sessionId === polledId;
}

/**
 * The outcome when a check could not even be started: no session exists and no
 * wallet was involved, so this must not read as a failed presentation.
 *
 * @param {number} status
 * @param {{error?: string}} body
 */
export function startFailure(status, body) {
  const reason = body?.error || (status === 0 ? 'the verifier service could not be reached' : `HTTP ${status}`);
  return { state: 'unavailable', reason };
}
