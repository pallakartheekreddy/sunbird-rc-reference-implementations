// Copy-paste presentation: put the request link on the clipboard, or, where
// the page has no clipboard access, hand it to a fallback that shows it to
// select by hand. The method must never silently do nothing.

/**
 * @param {string} text
 * @param {{clipboard?: {writeText: (t: string) => Promise<void>}, fallback: (t: string) => void}} io
 * @returns {Promise<'copied'|'fallback'>}
 */
export async function copyText(text, { clipboard, fallback }) {
  try {
    if (!clipboard?.writeText) throw new Error('no clipboard');
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    fallback(text);
    return 'fallback';
  }
}
