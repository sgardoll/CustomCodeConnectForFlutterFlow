import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyDefaultRoutes } from './apiFixtures.js';

// Byte-identical, test-only snapshot of the user's authoritative HTML. Never
// derive this oracle from app markup/CSS or replace its render-affecting assets.
function pinnedFile(path, sha256, contentType) {
  const body = readFileSync(new URL(path, import.meta.url));
  if (createHash('sha256').update(body).digest('hex') !== sha256) {
    throw new Error(`Canonical reference hash mismatch: ${path}`);
  }
  return { body, contentType };
}

const assets = {
  '/': pinnedFile('./custom-code-connect-hero.html', '548e628fe94f2b5e647cb4849fbc3200b43dcead60ea53c076f0085aca8917dc', 'text/html'),
  '/fonts/Delight-VF.ttf': pinnedFile('../../fonts/Delight-VF.ttf', 'c034c57b430cc5e394eb6d1a88655c694a98c8f32ee888255f41964f58c19075', 'font/ttf'),
  '/assets/flutterflow-icon.svg': pinnedFile('../../public/assets/flutterflow-icon.svg', 'b3d33379c329ac9aff23d80c002103a149625aa8cc0a850451915d1289fc6a98', 'image/svg+xml'),
};

export async function openCanonicalReference(page, viewport) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion:'no-preference' });
  await applyDefaultRoutes(page);
  // This origin is fulfilled entirely in-process: no reference server or live
  // API is needed. Unknown requests still reach the hermetic route guard.
  const origin = 'http://localhost:5432';
  await page.route(`${origin}/**`, route => {
    const asset = assets[new URL(route.request().url()).pathname];
    return asset ? route.fulfill(asset) : route.fallback();
  });
  await page.goto(origin);
  await page.evaluate(() => document.fonts.ready);
}
