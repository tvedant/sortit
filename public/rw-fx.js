/* RefundWaapsi FX — drop-in motion + speed layer (no dependencies).
   Same design, zero changes to your API/payment/chat logic. */
(() => {
'use strict';
const D = document, R = D.documentElement, raf = requestAnimationFrame;
const $ = (s, c = D) => c.querySelector(s), $$ = (s, c = D) => [...c.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover:hover) and (pointer:fine)').matches;
const isHome = !!$('#heroSection'), isDash = !!$('#screenList'), isAdmin = !!$('#agentManager');
const EASE = 'cubic-bezier(.22,1,.36,1)', SPRING = 'cubic-bezier(.34,1.56,.64,1)';
const io = (el, fn, o = { threshold: .25 }) => { const x = new IntersectionObserver(([e]) => { if (e.isIntersecting) { x.disconnect(); fn(e.target); } }, o); x.observe(el); };

/* ---------- 1. STYLES (compositor-only: transform / opacity / translate / scale) ---------- */
const st = D.createElement('style');
st.textContent = `
body::before{mix-blend-mode:normal!important;opacity:.045!important;transform:translateZ(0)}
.rw-off,.rw-off *{animation-play-state:paused!important}
.fighter,.float-particle,.marquee-inner,.ticker-inner{will-change:transform}
button:active:not(:disabled),.btn:active{scale:.97}
.loading-state{background:linear-gradient(100deg,#E8DBB8 30%,#F6EDD3 50%,#E8DBB8 70%) 0 0/300% 100%;animation:rw-shim 1.3s linear infinite}
@keyframes rw-shim{to{background-position:-300% 0}}
@keyframes rw-screen{from{opacity:0;translate:0 20px}}
@keyframes rw-pop{from{opacity:0;scale:.9;translate:0 12px}}
.rw-screen{animation:rw-screen .55s ${EASE} backwards}
.rw-pop{animation:rw-pop .5s ${SPRING} backwards;animation-delay:calc(var(--i,0)*50ms)}
.case-row,.case{transition:translate .3s ${EASE},box-shadow .3s ease,background .2s ease}
.case-row:hover{translate:6px 0;box-shadow:8px 8px 0 rgba(0,0,0,.18)}
.rw-w{display:inline-block;overflow:hidden;vertical-align:top;padding:.06em .05em .1em;margin:-.06em -.05em -.1em}
.rw-w>i{display:inline-block;font-style:normal;transform:translateY(112%) rotate(7deg);transform-origin:0 100%}
.rw-go .rw-w>i{transform:none;transition:transform .85s ${EASE};transition-delay:calc(var(--i)*60ms)}
.scroll-progress{width:100%!important;transform:scaleX(0);transform-origin:0 50%;will-change:transform}
nav{transition:box-shadow .3s ease,translate .5s ${EASE}!important}
nav.rw-hide{translate:0 -110%}
.btn,.cta-small{transition:transform .12s ease,box-shadow .12s ease,translate .4s ${SPRING}}
.rw-cur{position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border:3px solid #1A1611;background:#C1272D;border-radius:50%;pointer-events:none;z-index:9999;will-change:transform;opacity:0;transition:width .25s ${EASE},height .25s ${EASE},margin .25s ${EASE},background .25s,opacity .2s}
.rw-cur.on{opacity:1}.rw-cur.big{width:46px;height:46px;margin:-23px 0 0 -23px;background:rgba(232,163,61,.55)}
@supports(animation-timeline:view()){
.rope-divider{animation:rw-rope linear both;animation-timeline:view();animation-range:cover}
@keyframes rw-rope{from{background-position:0 0}to{background-position:283px 0}}
.gen-box,.poll-caption-box,.chat-lead-card,.price-card{animation:rw-rise linear both;animation-timeline:view();animation-range:entry 0% entry 55%}
@keyframes rw-rise{from{opacity:0;translate:0 70px;scale:.94}}
.ring{animation:rw-par linear both;animation-timeline:scroll(root);animation-range:0 100vh}
@keyframes rw-par{to{translate:0 60px;rotate:2deg}}
}`;
D.head.append(st);

/* ---------- 2. SPEED: skip identical re-renders, prefetch on intent ---------- */
// Your polls/SSE re-set innerHTML every few seconds even when nothing changed. Ignore identical writes:
// no DOM churn, no scroll resets, no hover flicker.
const dedupe = el => { if (!el) return; const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML'); let last = '';
  Object.defineProperty(el, 'innerHTML', { configurable: true, get() { return d.get.call(this); },
    set(v) { if (v === last && this.firstElementChild) return; last = v; d.set.call(this, v); } }); };
['caseList', 'chatMessages', 'messages'].forEach(id => dedupe(D.getElementById(id)));

const seen = new Set();
D.addEventListener('pointerover', e => { const a = e.target.closest && e.target.closest('a[href^="/"]');
  if (!a || seen.has(a.href) || a.pathname.startsWith('/api')) return; seen.add(a.href);
  const l = D.createElement('link'); l.rel = 'prefetch'; l.href = a.href; D.head.append(l); }, { passive: true });

/* ---------- 3. APP PAGES: screen / list / chat / number motion ---------- */
const onReveal = (s, fn) => { let hid = s.classList.contains('hidden');
  new MutationObserver(() => { const h = s.classList.contains('hidden'); if (hid && !h) fn(s); hid = h; }).observe(s, { attributes: true, attributeFilter: ['class'] }); };
if (!reduce) {
  $$('#screenList,#screenPay,#screenDetails,#screenCase').forEach(s => onReveal(s, el => { el.classList.remove('rw-screen'); void el.offsetWidth; el.classList.add('rw-screen'); }));

  const watchList = (el, sel) => { if (!el) return; let had = false;
    new MutationObserver(() => { const rows = $$(sel, el);
      if (rows.length && !had) rows.slice(0, 14).forEach((r, i) => { r.style.setProperty('--i', i); r.classList.add('rw-pop'); });
      had = rows.length > 0; }).observe(el, { childList: true }); };
  watchList($('#caseList'), '.case-row,.case');

  const watchChat = el => { if (!el) return; let prev = 0;
    new MutationObserver(() => { const k = [...el.children].filter(c => /msg/.test(c.className)), n = k.length;
      if (n > prev) k.slice(prev > 0 ? prev : Math.max(0, n - 10)).forEach((b, i) => { b.style.setProperty('--i', prev > 0 ? 0 : i); b.classList.add('rw-pop'); });
      prev = n; }).observe(el, { childList: true }); };
  watchChat($('#chatMessages')); watchChat($('#messages'));

  // Admin stat counters roll to their new value
  ['total', 'unassigned', 'mine', 'open'].forEach(id => { const el = D.getElementById(id); if (!el || !isAdmin) return;
    let cur = +el.textContent || 0, busy = false;
    new MutationObserver(() => { if (busy) return; const to = +el.textContent; if (isNaN(to) || to === cur) return;
      busy = true; const from = cur, t0 = performance.now(); cur = to;
      (function s(n) { const p = Math.min((n - t0) / 700, 1); el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
        if (p < 1) raf(s); else { el.textContent = to; busy = false; } })(t0);
    }).observe(el, { childList: true }); });
}

if (!isHome && !isDash) return;   // everything below is landing/dashboard flair

/* ---------- 4. TEXT: poster-slam word reveals ---------- */
function split(el) { let n = 0; const label = el.textContent.replace(/\s+/g, ' ').trim();
  (function walk(node) { [...node.childNodes].forEach(c => {
    if (c.nodeType === 3) { const f = D.createDocumentFragment();
      c.textContent.split(/(\s+)/).forEach(t => { if (!t) return; if (/^\s+$/.test(t)) { f.append(' '); return; }
        const w = D.createElement('span'), i = D.createElement('i'); w.className = 'rw-w'; w.setAttribute('aria-hidden', 'true');
        i.textContent = t; i.style.setProperty('--i', n++); w.append(i); f.append(w); });
      c.replaceWith(f);
    } else if (c.nodeType === 1 && c.tagName !== 'BR') walk(c); }); })(el);
  el.setAttribute('aria-label', label); }
if (!reduce) {
  $$('.hero-title,.section-title').forEach(t => split(t));
  const go = t => t.classList.add('rw-go');
  const hero = $('.hero-title'); if (hero) Promise.race([D.fonts ? D.fonts.ready : 0, new Promise(r => setTimeout(r, 400))]).then(() => raf(() => go(hero)));
  $$('.section-title').forEach(t => io(t, go, { threshold: .4 }));
}

/* ---------- 5. LANDING PAGE ---------- */
if (isHome) {
  // eased anchor scroll that re-measures every frame (robust while layout settles)
  var busy = false;
  D.addEventListener('click', e => { const a = e.target.closest('a[href^="#"]'); if (!a || reduce) return;
    const id = a.getAttribute('href').slice(1), t = id ? D.getElementById(id) : null; if (id && !t) return;
    e.preventDefault(); const y0 = scrollY, t0 = performance.now(); let stop = false; busy = true; R.style.scrollBehavior = 'auto';
    const off = t ? parseFloat(getComputedStyle(t).scrollMarginTop) || 0 : 0, dur = Math.min(1500, 500 + Math.abs(t ? t.getBoundingClientRect().top : y0) * .3);
    const cancel = () => stop = true; addEventListener('wheel', cancel, { once: true, passive: true }); addEventListener('touchstart', cancel, { once: true, passive: true });
    (function step(now) { const p = Math.min((now - t0) / dur, 1), k = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const dest = t ? t.getBoundingClientRect().top + scrollY - off : 0; scrollTo(0, y0 + (dest - y0) * k);
      if (p < 1 && !stop) raf(step); else { R.style.scrollBehavior = ''; busy = false; } })(t0);
    history.pushState(null, '', id ? '#' + id : location.pathname); });

  // pause off-screen animation work
  $$('.hero,.marquee-track,.ticker').forEach(el => new IntersectionObserver(([e]) => el.classList.toggle('rw-off', !e.isIntersecting)).observe(el));

  // poll bars grow in
  const pb = $('#pollBars'); if (pb && !reduce) io(pb, () => $$('.poll-fill', pb).forEach((f, i) => { f.style.transformOrigin = '0 50%';
    f.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 900, delay: i * 90, easing: EASE, fill: 'backwards' }); }), { threshold: .3 });

  // K.O. / hit screen-shake + haptics
  const v = $('#villain'), ring = $('.ring');
  if (v && ring && !reduce) new MutationObserver(() => { const ko = v.classList.contains('ko'); if (!ko && !v.classList.contains('hit')) return;
    const a = ko ? 14 : 5; ring.animate([{ transform: 'none' }, { transform: `translate(${a}px,${-a / 2}px)` }, { transform: `translate(${-a}px,${a / 2}px)` }, { transform: `translate(${a / 2}px,0)` }, { transform: 'none' }], { duration: 320, easing: 'ease-out' });
    if (navigator.vibrate) navigator.vibrate(ko ? [30, 40, 60] : 15); }).observe(v, { attributes: true, attributeFilter: ['class'] });

  // comic-book burst on every button hit
  const W = ['POW!', 'BAM!', 'ZAP!', 'WHAM!', 'BOOM!'];
  if (!reduce) D.addEventListener('pointerdown', e => { if (!e.target.closest('.btn,.cta-small,.poll-chip')) return;
    const b = D.createElement('div'), r = Math.random() * 40 - 20; b.textContent = W[Math.random() * W.length | 0];
    b.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9998;pointer-events:none;font:400 30px Anton,sans-serif;color:#E8A33D;-webkit-text-stroke:2px #1A1611;text-shadow:3px 3px 0 #1A1611;translate:-50% -50%`;
    D.body.append(b); b.animate([{ opacity: 0, transform: `scale(.2) rotate(${r - 20}deg)` }, { opacity: 1, transform: `scale(1.3) rotate(${r}deg)`, offset: .25 }, { opacity: 0, transform: `translateY(-60px) scale(1) rotate(${r}deg)` }], { duration: 650, easing: EASE }).onfinish = () => b.remove(); }, { passive: true });

  var nav = $('#siteNav'), bar = $('#scrollProgress'), anims = $$('.marquee-inner,.ticker-inner').flatMap(e => e.getAnimations());
  var fighters = [['.fighter.you', 14], ['.fighter.villain', -14], ['.you-label', 6], ['.villain-label', -6], ['.villain-tagline', -9]].map(([s, k]) => [$(s), k]).filter(x => x[0]);
  var heroOn = true; const h = $('#heroSection'); if (h) new IntersectionObserver(([e]) => heroOn = e.isIntersecting).observe(h);
}

/* ---------- 6. POINTER: magnetic buttons + cursor follower ---------- */
let mx = innerWidth / 2, my = innerHeight / 2, cx = mx, cy = my, px = 0, py = 0, tx = 0, ty = 0, cur = null;
if (fine && !reduce) {
  $$('.btn,.cta-small,.logo').forEach(el => {
    el.addEventListener('pointermove', e => { const b = el.getBoundingClientRect(); el.style.translate = `${(e.clientX - b.left - b.width / 2) * .18}px ${(e.clientY - b.top - b.height / 2) * .28}px`; }, { passive: true });
    el.addEventListener('pointerleave', () => el.style.translate = '');
  });
  cur = D.createElement('div'); cur.className = 'rw-cur'; cur.setAttribute('aria-hidden', 'true'); D.body.append(cur);
  addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; tx = mx / innerWidth - .5; ty = my / innerHeight - .5; cur.classList.add('on');
    cur.classList.toggle('big', !!e.target.closest('a,button,.btn,.poll-chip,.shame-card,.case-row,select,input,textarea')); }, { passive: true });
  D.addEventListener('pointerleave', () => cur.classList.remove('on'));
}

/* ---------- 7. ONE rAF LOOP drives everything scroll/pointer-linked ---------- */
if (!reduce && (cur || isHome)) {
  let lastY = scrollY, vel = 0, max = R.scrollHeight - innerHeight, rate = 1, hidden = false;
  new ResizeObserver(() => max = R.scrollHeight - innerHeight).observe(D.body);
  (function loop() {
    if (cur) { cx += (mx - cx) * .22; cy += (my - cy) * .22; cur.style.transform = `translate3d(${cx}px,${cy}px,0)`; }
    if (isHome) {
      const y = scrollY; vel += ((y - lastY) - vel) * .15; lastY = y;
      if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(y / max, 1) : 0})`;
      const r = 1 + Math.min(Math.abs(vel) * .35, 6);                       // marquees speed up with scroll velocity
      if (Math.abs(r - rate) > .02) { rate = r; anims.forEach(a => a.playbackRate = r); }
      const hide = !busy && y > 240 && vel > 3 && !nav.classList.contains('mobile-open');   // nav tucks away on scroll-down
      if (hide !== hidden && (hide || vel < -2 || y < 240 || busy)) { hidden = hide; nav.classList.toggle('rw-hide', hide); }
      if (heroOn) { px += (tx - px) * .08; py += (ty - py) * .08; fighters.forEach(([el, k]) => el.style.translate = `${px * k * 2}px ${py * k}px`); }
    }
    raf(loop);
  })();
}
})();
