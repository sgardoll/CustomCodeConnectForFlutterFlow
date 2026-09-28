/** Presentation-only handoffs from the canonical HTML. No clock advances a run.
 * A new outcome supersedes the old animation; every cancellation releases the
 * measured destination and removes all transient nodes/animations. */
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let active = null;
let exit = null;
const reveals = new Map();

function clearReveals() {
  for (const [node, finished] of reveals) {
    node.removeEventListener('animationend', finished);
    node.classList.remove('panel-in');
    node.style.animationDelay = '';
  }
  reveals.clear();
  document.querySelectorAll('.code-line.is-in').forEach(node => node.classList.remove('is-in'));
}

export function cancelSurfaceMotion() {
  clearReveals();
  if (active) {
    const current = active;
    active = null;
    current.animation?.cancel();
    current.ghost.remove();
    current.panel.style.visibility = '';
    delete current.panel.dataset.morphing;
    current.panel.inert = false;
  }
  if (exit) {
    exit.animation.cancel();
    exit.hero.classList.remove('is-exiting');
    exit.hero.style.cssText = exit.style;
    exit = null;
  }
}

export function currentSurfaceRect(fallback) {
  return (active?.ghost || fallback)?.getBoundingClientRect();
}

export function revealSurface(nodes) {
  clearReveals();
  nodes.filter(Boolean).forEach((node, index) => {
    node.classList.remove('panel-in');
    node.style.animationDelay = '';
    if (reduced.matches || document.hidden) return;
    void node.offsetWidth;
    node.style.animationDelay = `${index * 80}ms`;
    node.classList.add('panel-in');
    function finished(event) {
      if (event.target !== node) return;
      node.classList.remove('panel-in');
      node.style.animationDelay = '';
      node.removeEventListener('animationend', finished);
      reveals.delete(node);
    }
    reveals.set(node, finished);
    node.addEventListener('animationend', finished);
  });
}

export function exitHero(hero, rect) {
  if (!hero || !rect || reduced.matches || document.hidden || !hero.animate) return;
  const style = hero.style.cssText;
  hero.classList.add('is-exiting');
  if (innerWidth <= 920) {
    hero.style.cssText = `position:absolute;left:0;top:64px;width:${rect.width}px;height:${rect.height}px;transform:none;`;
  }
  const animation = hero.animate([{ opacity:1 }, { opacity:0 }], { duration:460, easing:'cubic-bezier(0.4,0,0.2,1)', fill:'both' });
  exit = { hero, animation, style };
  animation.onfinish = () => {
    if (exit?.animation !== animation) return;
    hero.classList.remove('is-exiting');
    hero.style.cssText = style;
    animation.cancel();
    exit = null;
  };
}

export function morphSurface(from, panel, nodes, { results = false } = {}) {
  cancelSurfaceMotion();
  if (!panel) return;
  const to = panel.getBoundingClientRect();
  const reveal = () => {
    panel.style.visibility = '';
    delete panel.dataset.morphing;
    panel.inert = false;
    revealSurface(nodes);
    if (document.activeElement === document.body || document.getElementById('hero')?.contains(document.activeElement)) {
      panel.querySelector(results ? '#results-summary-tab' : '#pipeline-edit-prompt')?.focus({ preventScroll:true });
    }
  };
  if (reduced.matches || document.hidden || !panel.animate || !from?.width || !to.width || (results && innerWidth <= 920)) {
    reveal();
    return;
  }
  panel.style.visibility = 'hidden';
  panel.dataset.morphing = 'true';
  panel.inert = true;
  const ghost = document.createElement('div');
  ghost.className = 'composer-morph';
  ghost.setAttribute('aria-hidden', 'true');
  const scale = innerWidth > 920 ? Math.min(1, innerWidth / 1920) : 1;
  ghost.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px;border-width:${2 * scale}px;border-radius:${20 * scale}px;`;
  document.body.appendChild(ghost);
  const dx = from.left + from.width / 2 - to.left - to.width / 2;
  const dy = from.top + from.height / 2 - to.top - to.height / 2;
  const sx = from.width / to.width, sy = from.height / to.height;
  const base = `translate(${dx}px,${dy}px) scale(${sx},${sy})`;
  const animation = ghost.animate([
    { transform:base, opacity:0, offset:0, easing:'cubic-bezier(.2,0,0,1)' },
    { transform:base, opacity:1, offset:.14, easing:'cubic-bezier(.4,0,.2,1)' },
    { transform:`translate(${dx}px,${dy}px) scale(${sx * .93},${sy * .93})`, opacity:1, offset:.28, easing:'cubic-bezier(.32,1.38,.5,1)' },
    { transform:'translate(0px,0px) scale(1,1)', opacity:1, offset:1 },
  ], { duration:1120, fill:'both' });
  const current = { panel, ghost, animation };
  active = current;
  animation.onfinish = () => {
    if (active !== current) return;
    cancelSurfaceMotion();
    reveal();
  };
}

window.addEventListener('resize', cancelSurfaceMotion);
window.addEventListener('pagehide', cancelSurfaceMotion);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelSurfaceMotion(); });
reduced.addEventListener('change', () => { if (reduced.matches) cancelSurfaceMotion(); });
