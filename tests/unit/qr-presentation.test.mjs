import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode-svg';

/**
 * The presentation QR, which a phone camera has to resolve from a laptop screen.
 *
 * Both properties below were absent and the symbol was unreadable on a device while
 * looking entirely ordinary to a reader, which is why they are asserted rather than
 * left to inspection.
 */

// The real shape: an openid4vp request carrying a did:web client_id and an https
// request_uri. The Education request is the longest in the showcase because it pins
// three credential types, so it is the one that fails first.
const PAYLOAD =
  'openid4vp://?client_id=did%3Aweb%3Asandbox-rc.sunbird.org%3A4bf472aa-8229-4fd9-b901-1bc71753bf2b' +
  '&request_uri=https%3A%2F%2Fsandbox-rc.sunbird.org%2Funiversity-vp%2Fvp%2Frequest-object%2F' +
  '24dd1a76-68ff-4ac0-b1b7-2cfe69c8e065';

/** The generator used by services/verifier/src/server.mjs, kept in step with it. */
function crispQrSvg(content) {
  const opts = { content, padding: 4, ecl: 'L' };
  const probe = new QRCode({ ...opts, width: 480, height: 480 }).svg();
  const widths = [...probe.matchAll(/width="([0-9.]+)"/g)].map((m) => Number(m[1]));
  const pitch = Math.min(...widths.filter((w) => w > 0 && w < 480));
  const modules = Number.isFinite(pitch) && pitch > 0 ? Math.round(480 / pitch) : 0;
  if (!modules) return probe;
  const side = modules * 8;
  const svg = new QRCode({ ...opts, width: side, height: side }).svg();
  return svg.replace('<svg ', `<svg viewBox="0 0 ${side} ${side}" preserveAspectRatio="xMidYMid meet" `);
}

describe('the presentation QR', () => {
  test('carries a viewBox, so it SCALES instead of clipping', () => {
    const svg = crispQrSvg(PAYLOAD);
    const vb = svg.match(/viewBox="([^"]+)"/);
    assert.ok(vb, 'without a viewBox the modules keep absolute coordinates');

    const [, , , vbWidth] = vb[1].split(' ').map(Number);
    const declared = Number(svg.match(/<svg[^>]*\swidth="(\d+)"/)[1]);
    assert.equal(
      vbWidth,
      declared,
      'the viewBox must cover the whole canvas, or the far modules fall outside it',
    );

    // The failure this guards: rendered smaller than the canvas, a viewBox-less SVG
    // shows only the top-left corner of the symbol. 44% of it was missing on the
    // admissions page, including the bottom-right alignment pattern.
    const furthest = Math.max(
      ...[...svg.matchAll(/x="([0-9.]+)"[^>]*width="([0-9.]+)"/g)].map(
        (m) => Number(m[1]) + Number(m[2]),
      ),
    );
    assert.ok(
      furthest <= vbWidth,
      `a module reaches ${furthest}, past the viewBox at ${vbWidth}`,
    );
  });

  test('module edges land on whole pixels', () => {
    const svg = crispQrSvg(PAYLOAD);
    const xs = [...svg.matchAll(/x="([0-9.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(xs.length > 0, 'expected module rects');
    const fractional = xs.filter((x) => !Number.isInteger(x));
    // shape-rendering:crispEdges snaps each rect to the device pixel grid on its own,
    // so fractional coordinates make neighbouring modules round apart and the symbol
    // grows hairline seams. 480/61 = 7.8688..., which is where those came from.
    assert.deepEqual(fractional, [], 'every module coordinate must be an integer');
  });

  test('the canvas is an exact multiple of the module count', () => {
    const svg = crispQrSvg(PAYLOAD);
    const side = Number(svg.match(/<svg[^>]*\swidth="(\d+)"/)[1]);
    const pitch = Math.min(
      ...[...svg.matchAll(/width="([0-9.]+)"/g)].map((m) => Number(m[1])).filter((w) => w > 0 && w < side),
    );
    assert.equal(side % pitch, 0, 'a non-integer pitch is what produced fractional coordinates');
    assert.ok(pitch >= 8, `module pitch ${pitch}px is too small for a phone camera`);
  });
});
