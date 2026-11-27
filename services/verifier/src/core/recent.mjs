// The anonymous "recent checks" list shown on /try/.
//
// Kept in memory and bounded on purpose, like the session store: DESIGN forbids
// a durable central history of holder activity. An entry says which demo site
// asked for which threshold and how it ended, and nothing that could identify
// the holder or link two checks: no transaction id, no holder DID, no claim
// values beyond the outcome, no IP. It is lost on restart, which is fine.

export const SITES = ['verifier', 'social', 'shop'];

const FINAL = new Set(['decided', 'rejected', 'declined', 'cancelled']);

/**
 * @param {{capacity?: number, maxAgeMs?: number, now?: () => number}} [options]
 */
export function recentChecks({ capacity = 50, maxAgeMs = 86_400_000, now = () => Date.now() } = {}) {
  /** @type {{id: string, t: number, entry: object}[]} newest last */
  let items = [];
  const seen = new Set();

  return {
    /** Records a session's result the first time it reaches a final state. */
    record(sessionId, session, body) {
      if (!body || !FINAL.has(body.state) || seen.has(sessionId)) return;
      const checks = Object.values(body.checks || {});
      const t = now();
      items.push({
        id: sessionId,
        t,
        entry: {
          at: new Date(t).toISOString(),
          site: session.site || 'verifier',
          threshold: session.threshold,
          wallet: session.queryMode === 'pex' ? 'inji' : 'openid',
          outcome: body.state === 'decided' ? body.decision : body.state,
          checksPassed: checks.filter((v) => v === 'OK').length,
          checksTotal: checks.length,
          // No `reason`: it is free text, and a rejection reason can carry an
          // upstream error naming internal hosts. The outcome says enough.
        },
      });
      seen.add(sessionId);
      if (items.length > capacity) {
        for (const dropped of items.splice(0, items.length - capacity)) seen.delete(dropped.id);
      }
    },

    /** Newest first, only entries younger than maxAgeMs. */
    list() {
      const cutoff = now() - maxAgeMs;
      return items
        .filter((i) => i.t >= cutoff)
        .reverse()
        .map((i) => i.entry);
    },
  };
}
