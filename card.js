// Runs in the page world so it can read X's React data and reuse its auth headers.
(() => {
  const CARD_WIDTH = 300;
  const GAP = 8;
  const GLIDE = '200ms cubic-bezier(0.215, 0.61, 0.355, 1)'; // ease-out cubic
  const HIDE_GRACE_MS = 100; // only while crossing to the card or a neighboring profile
  const FIRST_REVEAL_MS = 150; // slight delay before the first card; switches stay instant
  const WARM_MS = 300; // re-hover this soon after a hide counts as a switch
  const NEAR_PX = 16; // gap around the anchor that still counts as "between profiles"
  const FETCH_TIMEOUT_MS = 4000; // give up on the skeleton and show what we have
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search',
    'compose', 'login', 'logout', 'signup', 'tos', 'privacy', 'jobs', 'premium',
  ]);

  // ---- Data ----

  const auth = { authorization: null };
  const followedBy = new Map(); // user id -> { users, total }
  const overrides = new Map(); // user id -> { following }
  const fetched = new Map(); // handle -> full user, for profiles the page only had stubs for
  const inflight = new Map(); // handle -> Promise<full user | null>

  const apiHeaders = () => ({
    authorization: auth.authorization,
    'x-csrf-token': document.cookie.match(/(?:^|; )ct0=([^;]+)/)?.[1],
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
  });

  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === 'authorization') auth.authorization = value;
    return origSetHeader.apply(this, arguments);
  };

  // X's native card still requests "followers you know"; reuse the response.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const u = String(url);
    if (u.includes('/friends/following/list.json')) {
      const id = new URL(u, location.origin).searchParams.get('user_id');
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          followedBy.set(id, { users: data.users || [], total: data.total_count || 0 });
          if (state.user?.id === id) render();
        } catch {}
      });
    }
    return origOpen.apply(this, arguments);
  };

  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    return key && el[key];
  };

  let store = null;
  function findStore(el) {
    if (store) return store;
    for (let f = fiberOf(el); f; f = f.return) {
      const s = f.memoizedProps?.store;
      if (s?.getState) return (store = s);
    }
    return null;
  }

  // Accepts both the flat REST shape and the GraphQL { core, legacy } shape.
  function normalize(u) {
    const l = u.legacy || u;
    const screenName = u.core?.screen_name || l.screen_name;
    if (typeof screenName !== 'string') return null;
    const id = u.rest_id || l.id_str || u.id_str;
    const o = overrides.get(id) || {};
    return {
      id,
      screenName,
      name: u.core?.name || l.name || screenName,
      avatar: (u.avatar?.image_url || l.profile_image_url_https || '').replace('_normal.', '_200x200.'),
      avatarSmall: u.avatar?.image_url || l.profile_image_url_https || '',
      square: (u.profile_image_shape || l.profile_image_shape) === 'Square',
      bio: l.description || '',
      bioUrls: l.entities?.description?.urls || [],
      followers: l.followers_count ?? 0,
      following: l.friends_count ?? 0,
      blue: !!(u.is_blue_verified ?? l.is_blue_verified),
      verifiedType: u.verification?.verified_type || l.verified_type,
      iFollow: o.following ?? !!(u.relationship_perspectives?.following ?? l.following),
      followsMe: !!(u.relationship_perspectives?.followed_by ?? l.followed_by),
      canDM: u.dm_permissions?.can_dm ?? l.can_dm,
    };
  }

  // Mentions and face-piles carry stub users with no avatar or counts.
  const isFull = (u) => (u.legacy || u).followers_count != null;

  function matchUser(obj, handle, depth, full) {
    if (!obj || typeof obj !== 'object' || depth > 2 || obj.$$typeof || obj instanceof Node) return null;
    const sn = obj.core?.screen_name || obj.legacy?.screen_name || obj.screen_name;
    if (typeof sn === 'string' && sn.toLowerCase() === handle && (!full || isFull(obj))) return obj;
    for (const k in obj) {
      if (k === 'children') continue;
      const hit = matchUser(obj[k], handle, depth + 1, full);
      if (hit) return hit;
    }
    return null;
  }

  function fromFibers(link, handle, full) {
    let f = fiberOf(link);
    for (let i = 0; f && i < 40; i++, f = f.return) {
      const hit = matchUser(f.memoizedProps, handle, 0, full);
      if (hit) return hit;
    }
    return null;
  }

  function fromStore(link, handle) {
    const users = findStore(link)?.getState()?.entities?.users?.entities;
    for (const u of Object.values(users || {})) {
      if (u?.screen_name?.toLowerCase() === handle) return u;
    }
    return null;
  }

  function fullUser(link, handle) {
    const hit = fromFibers(link, handle, true) || fetched.get(handle) || fromStore(link, handle);
    return hit && isFull(hit) ? hit : null;
  }

  // Prefer a complete user; otherwise return what we have, marked as loading.
  function lookup(link, handle) {
    const full = fullUser(link, handle);
    if (full) return normalize(full);
    const stub = fromFibers(link, handle, false) || fromStore(link, handle);
    return { ...(stub ? normalize(stub) : normalize({ screen_name: handle })), loading: true };
  }

  // Race our own request against X's store, which the hidden native card fills.
  function loadFull(link, handle) {
    if (inflight.has(handle)) return inflight.get(handle);
    const p = new Promise((resolve) => {
      let unsub = () => {};
      const done = (u) => {
        unsub();
        clearTimeout(timer);
        inflight.delete(handle);
        if (u) fetched.set(handle, u);
        resolve(u);
      };
      const timer = setTimeout(() => done(null), FETCH_TIMEOUT_MS);
      const store = findStore(link);
      if (store?.subscribe) {
        unsub = store.subscribe(() => {
          const u = fromStore(link, handle);
          if (u && isFull(u)) done(u);
        });
      }
      fetch(`/i/api/1.1/users/show.json?screen_name=${encodeURIComponent(handle)}`, {
        credentials: 'include',
        headers: apiHeaders(),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((u) => u && isFull(u) && done(u))
        .catch(() => {});
    });
    inflight.set(handle, p);
    return p;
  }

  // ---- Card UI ----

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;display:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { --bg:#16181c; --fg:#e7e9ea; --dim:#71767b; --line:#2f3336; --link:#1d9bf0;
      --stroke:#3e4144; --outer:#0b0c0e; --btn-bg:#eff3f4; --btn-fg:#0f1419; }
    :host([theme=dim]) { --bg:#1e2732; --dim:#8b98a5; --line:#38444d; --stroke:#4a5560; }
    :host([theme=light]) { --bg:#fff; --fg:#0f1419; --dim:#536471; --line:#cfd9de;
      --stroke:#cfd9de; --outer:rgba(0,0,0,.08); --btn-bg:#0f1419; --btn-fg:#fff; }
    .card { width:${CARD_WIDTH}px; box-sizing:border-box; padding:16px; border-radius:16px;
      background:var(--bg); color:var(--fg);
      border:1px solid var(--stroke); box-shadow:0 0 0 1px var(--outer);
      font:15px/20px TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    a { color:inherit; text-decoration:none; } a:hover { text-decoration:underline; }
    .top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
    .avatar { width:64px; height:64px; border-radius:50%; object-fit:cover; display:block; background:var(--line) center/cover; }
    .avatar.square { border-radius:8px; }
    .btn { border:1px solid transparent; border-radius:9999px; padding:0 16px; height:36px; min-width:96px;
      font:700 15px TwitterChirp, -apple-system, sans-serif; cursor:pointer;
      background:var(--btn-bg); color:var(--btn-fg); }
    .btn.on { background:transparent; color:var(--fg); border-color:var(--line); }
    .btn.on:hover { color:#f4212e; border-color:#67070f; background:rgba(244,33,46,.1); }
    .name { font-weight:700; font-size:17px; display:flex; align-items:center; gap:2px; }
    .badge { width:20px; height:20px; flex:none; }
    .handle { color:var(--dim); display:flex; align-items:center; gap:4px; }
    .pill { font-size:12px; line-height:16px; padding:0 4px; border-radius:4px; background:var(--line); color:var(--dim); }
    .bio { margin-top:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
    .bio a { color:var(--link); }
    .stats { margin-top:12px; display:flex; gap:20px; }
    .stats b { color:var(--fg); } .stats span { color:var(--dim); }
    .known { margin-top:12px; display:flex; align-items:center; gap:8px; color:var(--dim); font-size:13px; line-height:16px; }
    .known img { width:20px; height:20px; border-radius:50%; border:2px solid var(--bg); margin-right:-10px; }
    .known .faces { display:flex; padding-right:10px; flex:none; }
    .sk { background:var(--line); border-radius:6px; animation:pulse 1.2s ease-in-out infinite; }
    .avatar.sk { border-radius:50%; }
    .sk-line { height:12px; margin-top:8px; }
    .sk-stats { height:14px; width:60%; margin-top:16px; }
    .btn[disabled] { opacity:.5; cursor:default; }
    .actions { display:flex; gap:8px; }
    .icon-btn { width:36px; height:36px; box-sizing:border-box; border:1px solid var(--line); border-radius:50%;
      display:flex; align-items:center; justify-content:center; color:var(--fg); }
    .icon-btn:hover { background:rgba(127,127,127,.1); text-decoration:none; }
    .icon-btn svg { width:20px; height:20px; fill:currentColor; }
    @keyframes pulse { 50% { opacity:.5; } }
  </style><div class="card"></div>`;
  const cardEl = root.querySelector('.card');
  const mount = () => document.documentElement.appendChild(host);
  document.documentElement ? mount() : document.addEventListener('DOMContentLoaded', mount);

  const BADGE = 'M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z';
  const MAIL = 'M1.998 5.5c0-1.381 1.119-2.5 2.5-2.5h15c1.381 0 2.5 1.119 2.5 2.5v13c0 1.381-1.119 2.5-2.5 2.5h-15c-1.381 0-2.5-1.119-2.5-2.5v-13zm2.5-.5c-.276 0-.5.224-.5.5v2.764l8 3.638 8-3.636V5.5c0-.276-.224-.5-.5-.5h-15zm15.5 5.463l-8 3.636-8-3.638V18.5c0 .276.224.5.5.5h15c.276 0 .5-.224.5-.5v-8.037z';
  const BADGE_COLOR = { Business: '#e2b719', Government: '#829aab' };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const count = (n) => (n >= 10000 ? compact.format(n) : n.toLocaleString('en'));

  function bioHtml(u) {
    let html = esc(u.bio);
    for (const { url, display_url, expanded_url } of u.bioUrls) {
      html = html.replace(esc(url), `<a href="${esc(expanded_url)}" target="_blank" rel="noopener">${esc(display_url)}</a>`);
    }
    return html.replace(/(^|[^\w])@(\w{1,15})/g, '$1<a href="/$2" data-nav>@$2</a>');
  }

  function knownHtml(id) {
    const k = followedBy.get(id);
    if (!k || !k.total) return '';
    const names = k.users.slice(0, 2).map((u) => esc(u.name));
    const rest = k.total - names.length;
    const text = rest > 0
      ? `${names.join(', ')}, and ${rest} other${rest > 1 ? 's' : ''} you follow`
      : names.join(' and ');
    const faces = k.users.slice(0, 3).map((u) => `<img src="${esc(u.profile_image_url_https)}">`).join('');
    return `<div class="known"><div class="faces">${faces}</div><div>Followed by ${text}</div></div>`;
  }

  function render() {
    const u = state.user;
    if (!u) return;
    const btn = u.iFollow ? 'Following' : u.followsMe ? 'Follow back' : 'Follow';
    const badge = u.blue || u.verifiedType
      ? `<svg class="badge" viewBox="0 0 22 22"><path fill="${BADGE_COLOR[u.verifiedType] || '#1d9bf0'}" d="${BADGE}"/></svg>`
      : '';
    const prevAvatar = cardEl.querySelector('img.avatar');
    const avatar = u.avatar
      ? `<img class="avatar${u.square ? ' square' : ''}" src="${esc(u.avatar)}" style="background-image:url(${esc(JSON.stringify(u.avatarSmall))})">`
      : `<div class="avatar${u.loading ? ' sk' : ''}"></div>`;
    const details = u.loading
      ? `<div class="sk sk-line"></div><div class="sk sk-line" style="width:70%"></div><div class="sk sk-stats"></div>`
      : `${u.bio ? `<div class="bio">${bioHtml(u)}</div>` : ''}
      ${u.partial ? '' : `<div class="stats">
        <a href="/${esc(u.screenName)}/following" data-nav><b>${count(u.following)}</b> <span>Following</span></a>
        <a href="/${esc(u.screenName)}/verified_followers" data-nav><b>${count(u.followers)}</b> <span>Followers</span></a>
      </div>`}
      ${knownHtml(u.id)}`;
    cardEl.innerHTML = `
      <div class="top">
        <a href="/${esc(u.screenName)}" data-nav>${avatar}</a>
        <div class="actions">
          ${u.id && !u.loading && u.canDM !== false ? `<a class="icon-btn" href="/messages/compose?recipient_id=${esc(u.id)}" data-nav title="Message"><svg viewBox="0 0 24 24"><path d="${MAIL}"/></svg></a>` : ''}
          <button class="btn${u.iFollow ? ' on' : ''}" data-follow${u.id ? '' : ' disabled'}>${btn}</button>
        </div>
      </div>
      <a class="name" href="/${esc(u.screenName)}" data-nav>${esc(u.name)}${badge}</a>
      <div class="handle">@${esc(u.screenName)}${u.followsMe ? '<span class="pill">Follows you</span>' : ''}</div>
      ${details}`;
    // Keep an already-loaded avatar across re-renders; fall back to the small cached size.
    const img = cardEl.querySelector('img.avatar');
    if (!img) return;
    if (prevAvatar && prevAvatar.getAttribute('src') === img.getAttribute('src')) img.replaceWith(prevAvatar);
    else img.onerror = () => { img.onerror = null; img.src = u.avatarSmall; };
  }

  function theme() {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg === 'rgb(255, 255, 255)') return 'light';
    if (bg === 'rgb(21, 32, 43)') return 'dim';
    return 'dark';
  }

  // ---- Show / hide ----

  const state = { user: null, anchor: null, visible: false, hideTimer: 0, showTimer: 0, pending: null, hiddenAt: -Infinity };

  function place(anchor, glide) {
    const a = anchor.getBoundingClientRect();
    const h = cardEl.offsetHeight;
    let y = a.bottom + GAP;
    if (y + h > innerHeight - GAP) y = Math.max(GAP, a.top - GAP - h);
    const x = Math.min(Math.max(GAP, a.left), innerWidth - CARD_WIDTH - GAP);
    host.style.transition = glide ? `transform ${GLIDE}` : 'none';
    host.style.transform = `translate(${x}px, ${y}px)`;
  }

  function show(link, handle) {
    const user = lookup(link, handle);
    clearTimeout(state.hideTimer);
    const glide = state.visible;
    state.user = user;
    state.anchor = link;
    host.setAttribute('theme', theme());
    render();
    host.style.display = 'block';
    place(link, glide);
    state.visible = true;
    if (user.loading) fill(link, handle, user);
  }

  async function fill(link, handle, stub) {
    const full = await loadFull(link, handle);
    if (state.user !== stub) return;
    if (!full && !stub.id) return hide(); // nothing to show
    state.user = full ? normalize(full) : { ...stub, loading: false, partial: true };
    render();
    place(link, true);
  }

  function hide() {
    clearTimeout(state.hideTimer);
    if (state.visible) state.hiddenAt = performance.now();
    host.style.display = 'none';
    state.visible = false;
    state.anchor = null;
  }

  function profileLink(target) {
    if (!(target instanceof Element) || target === host) return null;
    // Left sidebar (Profile link, account switcher) is your own account; leave it alone.
    if (target.closest('header[role="banner"]')) return null;
    const a = target.closest('a[href^="/"]');
    const m = a?.getAttribute('href').match(/^\/(\w{1,15})\/?$/);
    if (!m || RESERVED.has(m[1].toLowerCase())) return null;
    return { link: a, handle: m[1].toLowerCase() };
  }

  // True near the anchor or in the box spanning the anchor and the card.
  function inCorridor(x, y) {
    if (!state.anchor) return false;
    const a = state.anchor.getBoundingClientRect();
    const b = cardEl.getBoundingClientRect();
    const nearAnchor = x >= a.left - NEAR_PX && x <= a.right + NEAR_PX &&
      y >= a.top - NEAR_PX && y <= a.bottom + NEAR_PX;
    return nearAnchor || (x >= Math.min(a.left, b.left) && x <= Math.max(a.right, b.right) &&
      y >= Math.min(a.top, b.top) && y <= Math.max(a.bottom, b.bottom));
  }

  document.addEventListener('mouseover', (e) => {
    if (e.target === host) return clearTimeout(state.hideTimer);
    const hit = profileLink(e.target);
    if (hit) {
      // Avatar, name and @handle of one user share a card; don't jump between them.
      if (state.visible && hit.handle === state.user?.screenName.toLowerCase()) {
        clearTimeout(state.hideTimer);
        state.anchor = hit.link;
      } else if (state.visible || performance.now() - state.hiddenAt < WARM_MS) {
        show(hit.link, hit.handle);
      } else if (state.pending !== hit.link) {
        clearTimeout(state.showTimer);
        state.pending = hit.link;
        state.showTimer = setTimeout(() => {
          state.pending = null;
          show(hit.link, hit.handle);
        }, FIRST_REVEAL_MS);
      }
      return;
    }
    if (state.pending && !state.pending.contains(e.target)) {
      clearTimeout(state.showTimer);
      state.pending = null;
    }
    if (!state.visible) return;
    if (state.anchor?.contains(e.target)) return;
    if (inCorridor(e.clientX, e.clientY)) {
      clearTimeout(state.hideTimer);
      state.hideTimer = setTimeout(hide, HIDE_GRACE_MS);
    } else {
      hide();
    }
  }, true);

  host.addEventListener('mouseleave', (e) => {
    if (!state.anchor?.contains(e.relatedTarget)) hide();
  });

  addEventListener('scroll', () => state.visible && hide(), { capture: true, passive: true });
  // Clicking anything outside the card (e.g. opening the account menu) closes it.
  addEventListener('mousedown', (e) => state.visible && e.target !== host && hide(), true);

  // Same-tab links go through X's router instead of a full page load.
  root.addEventListener('click', (e) => {
    const followBtn = e.target.closest('[data-follow]');
    if (followBtn) return toggleFollow();
    const a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    hide();
    history.pushState({}, '', a.getAttribute('href'));
    dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  });

  async function toggleFollow() {
    const u = state.user;
    const next = !u.iFollow;
    u.iFollow = next;
    overrides.set(u.id, { following: next });
    render();
    try {
      const res = await fetch(`/i/api/1.1/friendships/${next ? 'create' : 'destroy'}.json`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...apiHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
        body: `user_id=${encodeURIComponent(u.id)}`,
      });
      if (!res.ok) throw new Error(res.status);
    } catch (err) {
      console.warn('[x-hovercard] follow failed', err);
      u.iFollow = !next;
      overrides.set(u.id, { following: !next });
      if (state.user === u) render();
    }
  }
})();
