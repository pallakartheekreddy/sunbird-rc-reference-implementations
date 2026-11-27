// Sunbird RC registry client.
//
// The issuer reads its source data through the registry's API, never straight
// from the tables (DESIGN §7). That is what keeps the registry the system of
// record instead of a database this service happens to share.

/**
 * @param {string} baseUrl
 */
export function registryClient(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(path, init) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
      throw Object.assign(new Error(`registry ${init?.method || 'GET'} ${path} → ${res.status}: ${detail}`), {
        status: res.status,
      });
    }
    return body;
  }

  return {
    /**
     * Finds exactly one AgeCitizen by its synthetic identifier.
     *
     * Returns null rather than throwing when absent, so the caller can answer
     * 404 without treating "no such citizen" as a stack failure.
     *
     * @param {string} citizenId
     */
    async findCitizen(citizenId) {
      const results = await call('/api/v1/AgeCitizen/search', {
        method: 'POST',
        body: JSON.stringify({ filters: { citizenId: { eq: citizenId } } }),
      });
      const list = Array.isArray(results) ? results : results?.data || [];
      if (list.length === 0) return null;
      if (list.length > 1) {
        // citizenId is a uniqueIndexField in the registry schema, so this can
        // only happen if the schema was changed or records were seeded around
        // it. Fail loudly: silently picking one would make issuance
        // nondeterministic, and the fixtures depend on it not being.
        throw new Error(`registry holds ${list.length} AgeCitizen records for ${citizenId}`);
      }
      return list[0];
    },

    /** @param {Record<string, unknown>} record */
    async createCitizen(record) {
      return call('/api/v1/AgeCitizen', { method: 'POST', body: JSON.stringify(record) });
    },

    /** Test citizens created by /try/ (ids starting TRY-), as {osid, citizenId}. */
    async listTryCitizens() {
      const results = await call('/api/v1/AgeCitizen/search', {
        method: 'POST',
        body: JSON.stringify({ filters: { citizenId: { startsWith: 'TRY-' } } }),
      });
      const list = Array.isArray(results) ? results : results?.data || [];
      return list.map(({ osid, citizenId }) => ({ osid, citizenId }));
    },

    async countTryCitizens() {
      return (await this.listTryCitizens()).length;
    },

    /** @param {string} osid */
    async deleteCitizen(osid) {
      return call(`/api/v1/AgeCitizen/${encodeURIComponent(osid)}`, { method: 'DELETE' });
    },

    async health() {
      return call('/health', { method: 'GET' });
    },
  };
}
