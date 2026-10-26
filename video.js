// Press and hold a playing video to watch at 2x, like the X phone app.
(() => {
  const HOLD_MS = 300; // shorter presses stay normal clicks
  const RATE = 2;
  const MOVE_PX = 10; // moving further than this before the hold kicks in cancels it

  let press = null; // { video, x, y, timer, prevRate, active }
  let swallow = false;

  const pill = document.createElement('div');
  pill.textContent = `${RATE}× ▶▶`;
  pill.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;padding:4px 10px;border-radius:9999px;' +
    'background:rgba(0,0,0,.65);color:#fff;font:700 13px/18px -apple-system,BlinkMacSystemFont,sans-serif;' +
    'transform:translateX(-50%);opacity:0;transition:opacity 150ms cubic-bezier(0.215,0.61,0.355,1);';

  function videoAt(target) {
    if (!(target instanceof Element) || target.closest('button, [role="slider"], input')) return null;
    const v = target.closest('[data-testid="videoComponent"], [data-testid="videoPlayer"]')?.querySelector('video');
    return v && !v.paused ? v : null;
  }

  function activate() {
    const { video } = press;
    press.active = true;
    press.prevRate = video.playbackRate;
    video.playbackRate = RATE;
    const r = video.getBoundingClientRect();
    pill.style.left = `${r.left + r.width / 2}px`;
    pill.style.top = `${r.top + 12}px`;
    document.documentElement.appendChild(pill);
    requestAnimationFrame(() => (pill.style.opacity = '1'));
  }

  function release() {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.active) {
      press.video.playbackRate = press.prevRate;
      pill.style.opacity = '0';
      swallow = true; // the release shouldn't also pause or open the video
      setTimeout(() => (swallow = false));
    }
    press = null;
  }

  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || document.documentElement.dataset.hovercraft === 'off') return;
    const video = videoAt(e.target);
    if (!video) return;
    release();
    press = { video, x: e.clientX, y: e.clientY, timer: setTimeout(activate, HOLD_MS), active: false };
  }, true);

  addEventListener('pointermove', (e) => {
    if (press && !press.active && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_PX) release();
  }, true);

  // Swallow the release so X's player doesn't treat the hold as a click.
  for (const type of ['pointerup', 'mouseup', 'click']) {
    addEventListener(type, (e) => {
      if (type === 'pointerup') release();
      if (!swallow) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
  addEventListener('pointercancel', release, true);
  addEventListener('blur', release);
})();
