// Injected into the page to render the "director" layer on top of the app:
// an animated cursor, click ripples, a caption pill, full-screen title cards,
// keycap pops, and smooth programmatic scrolling. Everything lives in a shadow
// host appended to <body> (outside React) so it survives in-app navigation.
// Exposes window.__promo. All motion is real-time so Chrome's screencast
// captures it as smooth video.

export const installOverlay = () => {
  if (window.__promo) return;
  const host = document.createElement('div');
  host.id = 'promo-overlay-host';
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,system-ui,sans-serif;';
  document.body.appendChild(host);

  const css = `
    .cursor{position:fixed;top:0;left:0;width:32px;height:32px;transform:translate(-100px,-100px);
      transition:transform 0.5s cubic-bezier(.22,.61,.36,1);will-change:transform;filter:drop-shadow(0 3px 6px rgba(0,0,0,.35));z-index:6;}
    .cursor svg{display:block}
    .cursor.press{transition:transform .09s ease}
    .ripple{position:fixed;width:14px;height:14px;border-radius:50%;background:rgba(13,148,136,.55);
      border:2px solid #0d9488;transform:translate(-50%,-50%) scale(.2);opacity:.9;z-index:5;}
    .ripple.go{animation:rip .55s ease-out forwards}
    @keyframes rip{to{transform:translate(-50%,-50%) scale(3.4);opacity:0}}
    .caption{position:fixed;left:50%;bottom:60px;transform:translate(-50%,16px);
      display:flex;flex-direction:column;align-items:center;gap:6px;opacity:0;
      transition:opacity .45s ease,transform .45s ease;z-index:7;max-width:80vw;}
    .caption.show{opacity:1;transform:translate(-50%,0)}
    .caption .pill{background:rgba(15,23,42,.88);color:#fff;padding:15px 28px;border-radius:18px;
      font-size:26px;font-weight:600;letter-spacing:-.01em;backdrop-filter:blur(8px);
      box-shadow:0 14px 46px rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.08);text-align:center;}
    .caption .pill .accent{color:#2dd4bf}
    .caption .sub{background:rgba(15,23,42,.72);color:#d3dbe6;padding:7px 17px;border-radius:12px;font-size:17px;font-weight:500;}
    .keycap{position:fixed;padding:9px 15px;background:#fff;color:#0f172a;border-radius:10px;font-weight:700;
      font-size:19px;box-shadow:0 6px 18px rgba(0,0,0,.28),inset 0 -3px 0 rgba(0,0,0,.12);
      border:1px solid rgba(0,0,0,.12);opacity:0;transform:translate(-50%,-50%) scale(.7);transition:opacity .15s,transform .15s;z-index:7;}
    .keycap.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
    .title{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:20px;opacity:0;transition:opacity .6s ease;z-index:8;
      background:radial-gradient(120% 120% at 50% 0%,#0f766e 0%,#0b3b39 46%,#071c1c 100%);}
    .title.show{opacity:1}
    .title .logo{display:flex;align-items:center;gap:16px}
    .title .mark{width:92px;height:92px;border-radius:24px;background:linear-gradient(150deg,#2dd4bf,#0d9488);
      display:flex;align-items:center;justify-content:center;box-shadow:0 18px 50px rgba(45,212,191,.35);}
    .title h1{color:#fff;font-size:72px;font-weight:800;letter-spacing:-.03em;margin:0}
    .title h1 .b{color:#5eead4}
    .title .tag{color:#a7f3e6;font-size:30px;font-weight:500;letter-spacing:-.01em;margin:0;text-align:center;max-width:72vw}
    .title .foot{color:#5eead4;font-size:16px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;opacity:.9}
    .title .rows{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;max-width:70vw}
    .title .chip{color:#d7fff7;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);
      padding:9px 16px;border-radius:999px;font-size:16px;font-weight:600}
    .vig{position:fixed;inset:0;z-index:4;pointer-events:none;box-shadow:inset 0 0 160px rgba(0,0,0,.14);opacity:0;transition:opacity .5s}
    .vig.show{opacity:1}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  host.appendChild(style);

  const CURSOR_SVG =
    '<svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M4 2l5.5 16 2.7-6.4L18.6 9 4 2z" fill="#fff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  const cursor = el('div', 'cursor');
  cursor.innerHTML = CURSOR_SVG;
  const vig = el('div', 'vig');
  const caption = el('div', 'caption');
  const pill = el('div', 'pill');
  const sub = el('div', 'sub');
  caption.append(pill, sub);
  const keycap = el('div', 'keycap');
  const title = el('div', 'title');
  host.append(vig, cursor, caption, keycap, title);

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let cx = -100;
  let cy = -100;

  const api = {
    setCursor(x, y) {
      cx = x;
      cy = y;
      cursor.style.transition = 'none';
      cursor.style.transform = `translate(${x}px,${y}px)`;
      // force reflow so a following transition applies
      void cursor.offsetWidth;
    },
    async moveCursor(x, y, ms = 600) {
      cx = x;
      cy = y;
      cursor.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`;
      cursor.style.transform = `translate(${x}px,${y}px)`;
      await wait(ms + 40);
    },
    async clickFx() {
      const r = el('div', 'ripple');
      r.style.left = cx + 8 + 'px';
      r.style.top = cy + 6 + 'px';
      host.appendChild(r);
      cursor.classList.add('press');
      cursor.style.transform = `translate(${cx}px,${cy}px) scale(.82)`;
      requestAnimationFrame(() => r.classList.add('go'));
      await wait(110);
      cursor.style.transform = `translate(${cx}px,${cy}px) scale(1)`;
      setTimeout(() => {
        r.remove();
        cursor.classList.remove('press');
      }, 560);
    },
    caption(html, subtitle) {
      pill.innerHTML = html;
      if (subtitle) {
        sub.textContent = subtitle;
        sub.style.display = '';
      } else {
        sub.style.display = 'none';
      }
      caption.classList.add('show');
    },
    hideCaption() {
      caption.classList.remove('show');
    },
    async key(label, x, y) {
      keycap.textContent = label;
      keycap.style.left = (x ?? cx) + 'px';
      keycap.style.top = (y ?? cy - 34) + 'px';
      keycap.classList.add('show');
      await wait(520);
      keycap.classList.remove('show');
      await wait(160);
    },
    vignette(on) {
      vig.classList.toggle('show', !!on);
    },
    showTitle(html) {
      title.innerHTML = html;
      title.classList.add('show');
    },
    hideTitle() {
      title.classList.remove('show');
    },
    async scrollEl(selector, top, ms = 900) {
      const node = document.querySelector(selector);
      if (!node) return;
      const start = node.scrollTop;
      const delta = top - start;
      const t0 = performance.now();
      await new Promise((resolve) => {
        const step = (t) => {
          const p = Math.min(1, (t - t0) / ms);
          const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
          node.scrollTop = start + delta * e;
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    ready: true,
  };
  window.__promo = api;
};
