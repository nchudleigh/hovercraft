// Runs in the page world so it can read X's React data and reuse its auth headers.
(() => {
  const CARD_WIDTH = 300;
  const GAP = 8;
  const EASE_OUT_CUBIC = 'cubic-bezier(0.215, 0.61, 0.355, 1)';
  const GLIDE = `200ms ${EASE_OUT_CUBIC}`;
  const HIDE_GRACE_MS = 100; // only while crossing to the card or a neighboring profile
  const FIRST_REVEAL_MS = 150; // slight delay before the first card; switches stay instant
  const WARM_MS = 300; // re-hover this soon after a hide counts as a switch
  const HOLD_MS = 1000; // press and hold a profile or the card this long to follow
  const NEAR_PX = 16; // gap around the anchor that still counts as "between profiles"
  const FETCH_TIMEOUT_MS = 4000; // give up on the skeleton and show what we have
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search',
    'compose', 'login', 'logout', 'signup', 'tos', 'privacy', 'jobs', 'premium',
  ]);

  // ---- Data ----

  const auth = { authorization: null };
  const overrides = new Map(); // user id -> { iFollow, muting, blocking }
  const fetched = new Map(); // handle -> full user, for profiles the page only had stubs for
  const inflight = new Map(); // handle -> Promise<full user | null>
  const followedBy = new Map(); // user id -> { users, total }

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

  // X's hidden native card still requests "followers you know"; reuse the response, no extra request.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(url).includes('/friends/following/list.json')) {
      const id = new URL(url, location.origin).searchParams.get('user_id');
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          followedBy.set(id, { users: data.users || [], total: data.total_count || 0 });
          if (state.visible && state.user?.id === id) { render(); place(state.anchor, true); }
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
      iFollow: o.iFollow ?? !!(u.relationship_perspectives?.following ?? l.following),
      muting: o.muting ?? !!(u.relationship_perspectives?.muting ?? l.muting),
      blocking: o.blocking ?? !!(u.relationship_perspectives?.blocking ?? l.blocking),
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
    /* X's theme tokens; Lights out and Dim share the card palette. */
    :host { --bg:#141414; --fg:#e7e9ea; --dim:#71767b; --line:#2f3336; --link:#1d9bf0;
      --shadow:0 4px 12px rgba(0,0,0,.5), 0 0 2px rgba(0,0,0,.35);
      --btn-bg:#eff3f4; --btn-fg:#0f1419; --btn-hover:#d7dbdc; --btn-line:#536471; --danger-line:#67070f; }
    :host([theme=dim]) { --line:#38444d; --shadow:0 0 15px rgba(101,119,134,.2), 0 0 3px 1px rgba(101,119,134,.15); }
    :host([theme=light]) { --bg:#fff; --fg:#0f1419; --dim:#536471; --line:#cfd9de;
      --shadow:0 0 15px rgba(101,119,134,.2), 0 0 3px 1px rgba(101,119,134,.15);
      --btn-bg:#0f1419; --btn-fg:#fff; --btn-hover:#272c30; --btn-line:#cfd9de; --danger-line:#fdc9ce; }
    .card { width:${CARD_WIDTH}px; box-sizing:border-box; padding:16px; border-radius:16px;
      background:var(--bg); color:var(--fg); box-shadow:var(--shadow);
      font:15px/20px TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    a { color:inherit; text-decoration:none; } a:hover { text-decoration:underline; }
    .avatar { width:44px; height:44px; border-radius:50%; object-fit:cover; display:block; background:var(--line) center/cover; }
    .avatar.square { border-radius:8px; }
    .btn { border:1px solid transparent; border-radius:9999px; padding:0 12px; height:32px; min-width:88px; white-space:nowrap;
      font:700 15px TwitterChirp, -apple-system, sans-serif; cursor:pointer;
      background:var(--btn-bg); color:var(--btn-fg); }
    .btn:not(.on):not([disabled]):hover { background:var(--btn-hover); }
    .btn.on { background:transparent; color:var(--fg); border-color:var(--btn-line); }
    .btn.on:hover { color:#f4212e; border-color:var(--danger-line); background:rgba(244,33,46,.1); }
    .btn { position:relative; overflow:hidden; isolation:isolate;
      transition:transform 160ms ${EASE_OUT_CUBIC}, background-color 200ms, color 200ms; }
    .btn::before { content:""; position:absolute; inset:0; z-index:-1; border-radius:inherit;
      background:color-mix(in srgb, var(--link) 45%, transparent);
      transform:scaleX(0); transform-origin:left; }
    .skull { position:relative; transition:transform 160ms ${EASE_OUT_CUBIC}; }
    .icon-btn svg.ring { position:absolute; inset:-1px; width:32px; height:32px; transform:rotate(-90deg); fill:none; }
    .ring circle { stroke:#f4212e; stroke-width:2; stroke-linecap:round; stroke-dasharray:1; stroke-dashoffset:1; opacity:0; }
    .btn.holding, .skull.holding { transform:scale(.94); }
    @media (prefers-reduced-motion: reduce) { .btn.holding, .skull.holding { transform:none; } }
    .name { font-weight:700; font-size:17px; display:flex; align-items:center; gap:2px; }
    .badge { width:20px; height:20px; flex:none; }
    .handle { color:var(--dim); display:flex; align-items:center; gap:4px; }
    .pill { font-size:12px; line-height:16px; padding:0 4px; border-radius:4px; background:var(--line); color:var(--dim); }
    .card { display:grid; grid-template-columns:auto 1fr; column-gap:10px;
      grid-template-areas:"av who" "details details" "actions actions" "bio bio" "known known"; }
    .av { grid-area:av; align-self:center; } .who { grid-area:who; align-self:center; min-width:0; }
    .details { grid-area:details; min-width:0; } .bio { grid-area:bio; min-width:0; }
    .actions { grid-area:actions; margin-top:12px; } [data-follow] { flex:1; }
    .bio { margin-top:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
    .bio a { color:var(--link); }
    .stats { margin-top:12px; display:flex; gap:20px; }
    .stats b { color:var(--fg); } .stats span { color:var(--dim); }
    .known { grid-area:known; margin-top:12px; display:flex; align-items:center; gap:8px; color:var(--dim); font-size:13px; line-height:16px; }
    .known img { width:20px; height:20px; border-radius:50%; border:2px solid var(--bg); flex:none; }
    .known img + img { margin-left:-10px; }
    .known .faces { display:flex; flex:none; }
    .sk { background:var(--line); border-radius:6px; animation:pulse 1.2s ease-in-out infinite; }
    .avatar.sk { border-radius:50%; }
    .sk-line { height:12px; margin-top:8px; } .sk-stats + .sk-line { margin-top:16px; }
    .sk-stats { height:14px; width:60%; margin-top:12px; }
    .btn[disabled] { opacity:.5; cursor:default; }
    .actions { display:flex; gap:6px; flex:none; position:relative; }
    button.icon-btn { background:none; padding:0; cursor:pointer; }
    .menu { position:absolute; left:0; top:38px; z-index:1; min-width:180px; padding:4px; border-radius:12px;
      background:var(--bg); border:1px solid var(--line); box-shadow:var(--shadow); }
    .menu button { display:block; width:100%; padding:8px 12px; border:0; border-radius:8px; background:none;
      color:var(--fg); font:inherit; font-weight:700; text-align:left; cursor:pointer; }
    .menu button:hover { background:rgba(127,127,127,.1); }
    .menu .danger { color:#f4212e; }
    .icon-btn { width:32px; height:32px; box-sizing:border-box; border:1px solid var(--btn-line); border-radius:50%;
      display:flex; align-items:center; justify-content:center; color:var(--fg); }
    .icon-btn:hover { background:color-mix(in srgb, currentColor 10%, transparent); text-decoration:none; }
    .icon-btn svg { width:18px; height:18px; fill:currentColor; }
    @keyframes pulse { 50% { opacity:.5; } }
  </style><div class="card"></div>`;
  const cardEl = root.querySelector('.card');
  const mount = () => document.documentElement.appendChild(host);
  document.documentElement ? mount() : document.addEventListener('DOMContentLoaded', mount);

  const BADGE = 'M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z';
  const CHAT = 'M12 3.5a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.4-1.1A8.5 8.5 0 1 0 12 3.5z';
  const MORE = 'M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z';
  const SKULL = 'M12 2C7 2 3.5 5.6 3.5 10.2c0 2.7 1.3 4.6 3 5.8V19c0 .8.7 1.5 1.5 1.5h1V18h1.5v2.5h3V18h1.5v2.5h1c.8 0 1.5-.7 1.5-1.5v-3c1.7-1.2 3-3.1 3-5.8C20.5 5.6 17 2 12 2zM8.5 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm7 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM12 15l1.2 2h-2.4z';
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

  // X's wording: up to three names, or two names "and N others you follow".
  function knownHtml(u) {
    const k = followedBy.get(u.id);
    if (!k?.total) return '';
    const names = k.users.slice(0, 3).map((f) => esc(f.name));
    const text = k.total > 3
      ? `${names[0]}, ${names[1]}, and ${k.total - 2} others you follow`
      : names.length === 3 ? `${names[0]}, ${names[1]}, and ${names[2]}` : names.join(' and ');
    const faces = k.users.slice(0, 3)
      .map((f, i) => `<img src="${esc(f.profile_image_url_https)}" style="z-index:${3 - i}">`).join('');
    return `<a class="known" href="/${esc(u.screenName)}/followers_you_follow" data-nav><div class="faces">${faces}</div><div>Followed by ${text}</div></a>`;
  }

  function render() {
    const u = state.user;
    if (!u) return;
    const btn = u.blocking ? 'Blocked' : u.iFollow ? 'Following' : u.followsMe ? 'Follow back' : 'Follow';
    const at = `@${esc(u.screenName)}`;
    const menu = state.menu ? `<div class="menu">
      <button data-act="mute">${u.muting ? 'Unmute' : 'Mute'} ${at}</button>
      <button data-act="block" class="danger">${u.blocking ? 'Unblock' : state.confirm === 'block' ? 'Confirm block' : 'Block'} ${at}</button>
    </div>` : '';
    const badge = u.blue || u.verifiedType
      ? `<svg class="badge" viewBox="0 0 22 22"><path fill="${BADGE_COLOR[u.verifiedType] || '#1d9bf0'}" d="${BADGE}"/></svg>`
      : '';
    const prevAvatar = cardEl.querySelector('img.avatar');
    const avatar = u.avatar
      ? `<img class="avatar${u.square ? ' square' : ''}" src="${esc(u.avatar)}" style="background-image:url(${esc(JSON.stringify(u.avatarSmall))})">`
      : `<div class="avatar${u.loading ? ' sk' : ''}"></div>`;
    const details = u.loading
      ? `<div class="sk sk-stats"></div><div class="sk sk-line"></div><div class="sk sk-line" style="width:70%"></div>`
      : `${u.partial ? '' : `<div class="stats">
        <a href="/${esc(u.screenName)}/following" data-nav><b>${count(u.following)}</b> <span>Following</span></a>
        <a href="/${esc(u.screenName)}/verified_followers" data-nav><b>${count(u.followers)}</b> <span>Followers</span></a>
      </div>`}`;
    cardEl.innerHTML = `
      <a class="av" href="/${esc(u.screenName)}" data-nav>${avatar}</a>
      <div class="actions">
        ${u.id && !u.loading ? `<button class="icon-btn" data-more title="More"><svg viewBox="0 0 24 24"><path d="${MORE}"/></svg></button>` : ''}
        ${u.id && !u.loading && !u.blocking ? `<button class="icon-btn skull" data-skull title="Press and hold to block"><svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="${SKULL}"/></svg><svg class="ring" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" pathLength="1"/></svg></button>` : ''}
        ${u.id && !u.loading && u.canDM !== false ? `<a class="icon-btn" href="/messages/compose?recipient_id=${esc(u.id)}" data-nav title="Message"><svg viewBox="0 0 24 24"><path d="${CHAT}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></a>` : ''}
        <button class="btn${u.iFollow || u.blocking ? ' on' : ''}" data-follow${u.id ? '' : ' disabled'}>${btn}</button>
        ${menu}
      </div>
      <div class="who">
        <a class="name" href="/${esc(u.screenName)}" data-nav>${esc(u.name)}${badge}</a>
        <div class="handle">@${esc(u.screenName)}${u.followsMe ? '<span class="pill">Follows you</span>' : ''}${u.muting ? '<span class="pill">Muted</span>' : ''}</div>
      </div>
      <div class="details">${details}</div>
      ${u.bio && !u.loading ? `<div class="bio">${bioHtml(u)}</div>` : ''}
      ${u.loading ? '' : knownHtml(u)}`;
    if (hold) { holdButton()?.classList.add('holding'); hold.anims = fillButton(holdButton(), performance.now() - hold.start); }
    // Keep an already-loaded avatar across re-renders; fall back to the small cached size.
    const img = cardEl.querySelector('img.avatar');
    if (!img) return;
    if (prevAvatar && prevAvatar.getAttribute('src') === img.getAttribute('src')) img.replaceWith(prevAvatar);
    else img.onerror = () => { img.onerror = null; img.src = u.avatarSmall; };
  }

  function theme() {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg === 'rgb(255, 255, 255)') return 'light';
    if (bg === 'rgb(1, 12, 18)' || bg === 'rgb(21, 32, 43)') return 'dim'; // new and old Dim
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
    cancelHold(); // never follow someone the hold didn't start on
    const user = lookup(link, handle);
    clearTimeout(state.hideTimer);
    const glide = state.visible;
    state.user = user;
    state.anchor = link;
    state.menu = state.confirm = false;
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
    cancelHold();
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

  // Set by bridge.js from the popup toggle.
  const disabled = () => document.documentElement.dataset.hovercraft === 'off';

  document.addEventListener('mouseover', (e) => {
    if (disabled()) return state.visible && hide();
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
  addEventListener('mousedown', (e) => {
    if (!state.visible) return;
    if (e.button === 0 && startHold(e)) return;
    if (e.target !== host) hide();
  }, true);

  // ---- Press and hold to follow ----

  let hold = null; // { start, timer, sel }
  let audio = null;
  // Created on a user gesture so autoplay rules allow it.
  const ensureAudio = () => { try { audio ||= new AudioContext(); audio.resume(); } catch {} };

  // Soft two-note chime.
  function chime() {
    const ctx = audio;
    if (!ctx) return;
    const t = ctx.currentTime;
    [[660, 0], [990, 0.07]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + delay);
      gain.gain.linearRampToValueAtTime(0.04, t + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.4);
    });
  }
  let swallowClick = false;

  const followButton = () => cardEl.querySelector('[data-follow]');
  const holdButton = () => hold && cardEl.querySelector(hold.sel);

  // The skull draws a red ring and turns red; other buttons fill from the left. Returns the animations.
  function fillButton(btn, elapsed) {
    if (!btn) return [];
    const ring = btn.querySelector('.ring circle');
    // Linear ring so it reads as a timer: half held, half drawn.
    const opts = { duration: HOLD_MS, easing: ring ? 'linear' : EASE_OUT_CUBIC, fill: 'forwards' };
    const anims = ring
      ? [ring.animate([{ strokeDashoffset: 1, opacity: 1 }, { strokeDashoffset: 0, opacity: 1 }], opts),
        btn.animate([{ color: '#f4212e' }], opts)]
      : [btn.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { ...opts, pseudoElement: '::before' })];
    for (const a of anims) a.currentTime = elapsed;
    return anims;
  }

  // Fill fraction at time t, so a cancel drains from where the eased fill actually is.
  const fillAt = (t) => 1 - (1 - t) ** 3;

  function startHold(e) {
    const u = state.user;
    if (!u?.id || u.loading || u.blocking) return false;
    const path = e.composedPath();
    const skull = path.some((el) => el.matches?.('[data-skull]'));
    if (!skull) {
      if (u.iFollow) return false;
      const onCard = path.includes(host) && !path.some((el) => el.matches?.('[data-follow], .icon-btn, .menu'));
      if (!onCard && !state.anchor?.contains(e.target)) return false;
    }
    e.preventDefault(); // no link drag or text selection while holding
    cancelHold();
    hold = { start: performance.now(), timer: setTimeout(skull ? completeSkull : completeHold, HOLD_MS),
      sel: skull ? '[data-skull]' : '[data-follow]' };
    ensureAudio();
    holdButton()?.classList.add('holding');
    hold.anims = fillButton(holdButton(), 0);
    return true;
  }

  function completeSkull() {
    hold = null;
    swallowClick = true;
    blast();
  }

  function completeHold() {
    hold = null;
    swallowClick = true; // the release shouldn't also open the profile
    chime();
    toggle('follow');
    if (!reduced()) {
      followButton()?.animate([{ transform: 'scale(.96)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }],
        { duration: 300, easing: EASE_OUT_CUBIC });
    }
  }

  function cancelHold() {
    if (!hold) return;
    clearTimeout(hold.timer);
    const t = Math.min(1, (performance.now() - hold.start) / HOLD_MS);
    const btn = holdButton();
    const p = btn?.querySelector('.ring') ? t : fillAt(t);
    const color = btn && getComputedStyle(btn).color;
    // The fill animations hold their end state, so they must go or the ring stays drawn.
    for (const a of hold.anims || []) a.cancel();
    hold = null;
    btn?.classList.remove('holding');
    const ring = btn?.querySelector('.ring circle');
    const opts = { duration: 200, easing: EASE_OUT_CUBIC };
    if (ring) {
      ring.animate([{ strokeDashoffset: 1 - p, opacity: 1 }, { strokeDashoffset: 1, opacity: 0 }], opts);
      btn.animate([{ color }, {}], opts);
    } else btn?.animate([{ transform: `scaleX(${p})` }, { transform: 'scaleX(0)' }], { ...opts, pseudoElement: '::before' });
  }

  addEventListener('mouseup', () => {
    cancelHold();
    setTimeout(() => (swallowClick = false));
  }, true);
  addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  addEventListener('dragstart', cancelHold, true);

  // Same-tab links go through X's router instead of a full page load.
  root.addEventListener('click', (e) => {
    const followBtn = e.target.closest('[data-follow]');
    if (followBtn) return toggle(state.user.blocking ? 'block' : 'follow');
    if (e.target.closest('[data-more]')) {
      state.menu = !state.menu;
      state.confirm = false;
      return render();
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) {
      // Blocking takes a second click so a stray click can't block someone.
      if (act === 'block' && !state.user.blocking && state.confirm !== act) {
        state.confirm = act;
        return render();
      }
      state.menu = state.confirm = false;
      const blocking = act === 'block' && !state.user.blocking;
      toggle(act);
      return blocking && bonk();
    }
    if (state.menu) {
      state.menu = state.confirm = false;
      render();
    }
    const a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    hide();
    history.pushState({}, '', a.getAttribute('href'));
    dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  });

  const ACTIONS = {
    follow: { key: 'iFollow', on: 'friendships/create', off: 'friendships/destroy' },
    mute: { key: 'muting', on: 'mutes/users/create', off: 'mutes/users/destroy' },
    block: { key: 'blocking', on: 'blocks/create', off: 'blocks/destroy' },
  };

  async function toggle(action) {
    const u = state.user;
    const { key, on, off } = ACTIONS[action];
    const prev = { iFollow: u.iFollow, muting: u.muting, blocking: u.blocking };
    const save = () => overrides.set(u.id, { iFollow: u.iFollow, muting: u.muting, blocking: u.blocking });
    const next = !u[key];
    u[key] = next;
    if (action === 'block' && next) u.iFollow = false; // X unfollows on block
    save();
    render();
    try {
      const res = await fetch(`/i/api/1.1/${next ? on : off}.json`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...apiHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
        body: `user_id=${encodeURIComponent(u.id)}`,
      });
      if (!res.ok) throw new Error(res.status);
      return true;
    } catch (err) {
      console.warn(`[x-hovercard] ${action} failed`, err);
      Object.assign(u, prev);
      save();
      if (state.user === u) render();
      return false;
    }
  }

  // ---- Block animations ----

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Normal block: the card flinches and "Blocked" stamps down.
  function bonk() {
    if (reduced()) return;
    cardEl.animate([0, -10, 9, -6, 4, -2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 400, easing: 'ease-out' });
    cardEl.animate([{ boxShadow: '0 0 0 2px #f4212e, 0 0 24px #f4212e' }, {}], { duration: 600 });
    followButton()?.animate([{ transform: 'scale(1.6) rotate(-10deg)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 260, easing: 'cubic-bezier(.5, 0, .75, 0)' });
  }

  // Skull hold: block the author, confetti out of their avatar, and remove their reply.
  // Outside a tweet there's no reply to remove, so it's just the confetti.
  function blast() {
    const anchor = state.anchor;
    const article = anchor?.closest('article');
    const head = anchor?.getBoundingClientRect();
    const shown = state.user;
    const reduceMotion = reduced();
    if (reduceMotion) hide();
    else cardEl.animate([{}, { opacity: 0, transform: 'scale(.96)' }], { duration: 150, easing: 'ease-in' })
      .onfinish = () => state.user === shown && hide();
    const cell = article && (article.closest('[data-testid="cellInnerDiv"]') || article);
    let restore = () => {};
    if (head && !reduceMotion) {
      restore = party(article, cell, head);
    } else if (cell) {
      const fade = cell.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
      restore = () => fade.cancel();
    }
    toggle('block').then((ok) => {
      if (ok) document.dispatchEvent(new Event('hovercraft:skull-blocked'));
      else restore();
    });
  }

  // Shrinks the timeline cell away; returns an undo.
  function collapse(cell, delay) {
    cell.style.overflow = 'hidden';
    const a = cell.animate([{ height: `${cell.offsetHeight}px` }, { height: '0px' }],
      { delay, duration: 300, easing: EASE_OUT_CUBIC, fill: 'forwards' });
    return () => { a.cancel(); cell.style.overflow = ''; };
  }

  // Grunt birthday party: confetti out of their head, then the reply goes.
  function party(article, cell, head) {
    document.dispatchEvent(new Event('hovercraft:party')); // bridge.js plays the sound
    confetti(head.left + head.width / 2, head.top + head.height / 2);
    if (!cell) return () => {};
    const out = article.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)', filter: 'blur(4px)' }],
      { delay: 500, duration: 400, easing: 'ease-in', fill: 'forwards' });
    const uncollapse = collapse(cell, 900);
    return () => { out.cancel(); uncollapse(); };
  }

  // Port of Beachball's ConfettiBurst: flash, haze, 40 streaks, 150 paper cards, 90 glow dots.
  const PAPER = [[[242, 240, 140], 0.38], [[148, 217, 214], 0.2], [[184, 235, 117], 0.18], [[250, 250, 235], 0.08],
    [[115, 158, 245], 0.07], [[250, 158, 71], 0.06], [[163, 133, 242], 0.03]];
  const STREAKS = [[[255, 245, 158], 0.65], ...PAPER.filter((_, i) => i !== 0 && i !== 3).map(([c, w]) => [c, w / 0.54 * 0.35])];
  const ASPECTS = [[[3, 3], 0.4], [[3, 2], 0.25], [[4, 2], 0.2], [[2, 2], 0.15]];
  const FLASH = [[0, 'rgba(255,255,240,1)'], [0.22, 'rgba(255,235,140,.9)'], [0.45, 'rgba(255,158,64,.35)'], [1, 'rgba(255,153,51,0)']];
  const HAZE = [[0, 'rgba(255,250,217,.35)'], [0.5, 'rgba(255,242,179,.18)'], [1, 'rgba(255,242,179,0)']];
  const PARTY_S = 3;

  function confetti(x, y) {
    const pick = (list) => {
      let roll = Math.random() * list.reduce((sum, [, w]) => sum + w, 0);
      return (list.find(([, w]) => (roll -= w) < 0) || list[list.length - 1])[0];
    };
    const rand = (a, b) => a + Math.random() * (b - a);
    const rgba = ([r, g, b], k = 1, a = 1) => `rgba(${r * k},${g * k},${b * k},${a})`;
    const ease = (p) => 1 - (1 - p) ** 2;
    const TAU = Math.PI * 2;

    const dpr = devicePixelRatio || 1;
    const cv = document.createElement('canvas');
    cv.width = innerWidth * dpr;
    cv.height = innerHeight * dpr;
    cv.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';
    document.documentElement.appendChild(cv);
    const ctx = cv.getContext('2d');

    const streaks = Array.from({ length: 40 }, (_, i) => {
      const c = pick(STREAKS);
      return { a: (i / 40) * TAU + rand(-0.08, 0.08), len: rand(150, 330), c,
        core: c.map((v) => v * 0.4 + 153) };
    });
    // Paper is born spread through the burst's volume rather than thrown from a point.
    const cards = Array.from({ length: 150 }, () => {
      const at = rand(0, TAU), r = 170 * Math.sqrt(Math.random());
      const dir = rand(0, TAU), v = rand(40, 180);
      const [w, h] = pick(ASPECTS);
      const sc = rand(0.75, 1.25);
      return { x: Math.cos(at) * r, y: Math.sin(at) * r, vx: Math.cos(dir) * v, vy: Math.sin(dir) * v,
        rot: rand(0, TAU), spin: rand(-3, 13), w: w * sc, h: h * sc, life: rand(2.1, 2.7),
        color: rgba(pick(PAPER), Math.random() < 0.6 ? 1 : 0.72) };
    });
    const dots = Array.from({ length: 90 }, () => {
      const dir = rand(0, TAU), v = rand(140, 500);
      return { vx: Math.cos(dir) * v, vy: Math.sin(dir) * v, life: rand(0.3, 0.7), s: rand(0.15, 0.45) };
    });

    const radial = (cx, cy, r, stops, alpha) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      for (const [o, c] of stops) g.addColorStop(o, c);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    };

    const t0 = performance.now();
    requestAnimationFrame(function frame(now) {
      const t = (now - t0) / 1000;
      if (t > PARTY_S) return cv.remove();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalCompositeOperation = 'lighter';

      // Flash holds bright, then cuts; haze lingers behind it.
      const fp = (t - 0.03) / 0.14;
      if (fp > 0 && fp < 1) radial(x, y, 210 * (0.7 + 0.45 * ease(fp)), FLASH, fp < 0.3 ? 1 : 1 - (fp - 0.3) / 0.7);
      const hp = (t - 0.05) / 0.65;
      if (hp > 0 && hp < 1) radial(x, y, 160 * (0.9 + 0.35 * ease(hp)), HAZE, 1 - ease(hp));

      if (t < 0.3) {
        const p = Math.min(t / 0.26, 1);
        for (const s of streaks) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(s.a);
          const start = 40 + s.len * 0.35 * p;
          const len = s.len * (0.6 + 0.4 * ease(Math.min(t / 0.08, 1)));
          const g = ctx.createLinearGradient(start, 0, start + len, 0);
          g.addColorStop(0, rgba(s.c, 1, 0));
          g.addColorStop(0.6, rgba(s.c, 1, 0.85));
          g.addColorStop(1, rgba(s.core));
          ctx.globalAlpha = t < 0.14 ? 1 : Math.max(0, 1 - (t - 0.14) / 0.16);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(start, -1);
          ctx.lineTo(start + len, -3.5);
          ctx.lineTo(start + len, 3.5);
          ctx.lineTo(start, 1);
          ctx.fill();
          radial(40 + s.len * (0.6 + 0.75 * p), 0, 8,
            [[0, '#fff'], [0.22, rgba(s.c, 1, 0.95)], [0.5, rgba(s.c, 1, 0.3)], [1, rgba(s.c, 1, 0)]],
            t < 0.16 ? 1 : Math.max(0, 1 - (t - 0.16) / 0.14));
          ctx.restore();
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      const pop = t < 0.1 ? 0.55 + 0.45 * ease(t / 0.1) : 1;
      for (const c of cards) {
        if (t > c.life) continue;
        ctx.save();
        ctx.translate(x + (c.x + c.vx * t) * pop, y + (c.y + c.vy * t + 95 * t * t) * pop);
        ctx.rotate(c.rot + c.spin * t);
        ctx.globalAlpha = Math.max(0, 1 - 0.3 * t);
        ctx.fillStyle = c.color;
        ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
        ctx.restore();
      }

      ctx.globalCompositeOperation = 'lighter';
      for (const d of dots) {
        const r = (d.s - 0.3 * t) * 8;
        const a = 0.8 - 1.6 * t;
        if (t > d.life || r <= 0 || a <= 0) continue;
        radial(x + d.vx * t, y + d.vy * t + 125 * t * t, r,
          [[0, 'rgba(255,247,191,1)'], [0.45, 'rgba(255,247,191,.35)'], [1, 'rgba(255,247,191,0)']], a);
      }
      requestAnimationFrame(frame);
    });
  }
})();
