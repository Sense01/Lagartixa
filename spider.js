import { sleep } from './util.js';

let FAST = false;
export const setFast = (v) => { FAST = v; };

// Aranha animada (com fio de seda preso ao topo da página) no lugar do cursor
export async function ensureCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__spider')) return;
    const T = 'left .6s ease, top .6s ease, height .6s ease';
    const thread = document.createElement('div');
    thread.id = '__thread';
    thread.style.cssText =
      'position:fixed;z-index:2147483646;width:2px;left:80px;top:0;height:80px;' +
      'background:#777;box-shadow:0 0 2px #fff;pointer-events:none;transition:' + T;
    const sp = document.createElement('div');
    sp.id = '__spider';
    sp.style.cssText =
      'position:fixed;z-index:2147483647;left:80px;top:80px;width:56px;height:56px;' +
      'margin:-28px 0 0 -28px;pointer-events:none;transition:' + T;
    const leg = (d) => `<path d="${d}"/>`;
    const L = [
      'M-6 -6 Q-18 -22 -26 -20', 'M-7 -2 Q-22 -10 -28 -4',
      'M-7 3 Q-22 8 -28 14', 'M-6 7 Q-16 22 -24 26',
    ];
    const R = L.map((d) => d.replace(/-?\d+(\.\d+)?/g, (n, i, s) => n).replace(/(-?\d+) (-?\d+)/g, (m, a, b) => (-a) + ' ' + b));
    sp.innerHTML =
      '<svg viewBox="-30 -30 60 60" width="56" height="56" style="transition:transform .3s ease">' +
      '<g stroke="#111" stroke-width="2.6" fill="none" stroke-linecap="round">' +
      '<g>' + L.map(leg).join('') +
      '<animateTransform attributeName="transform" type="rotate" values="-5 0 0;5 0 0;-5 0 0" dur=".45s" repeatCount="indefinite"/></g>' +
      '<g>' + R.map(leg).join('') +
      '<animateTransform attributeName="transform" type="rotate" values="5 0 0;-5 0 0;5 0 0" dur=".45s" repeatCount="indefinite"/></g>' +
      '</g>' +
      '<ellipse cx="0" cy="5" rx="9" ry="12" fill="#1c1c1c"/>' +
      '<circle cx="0" cy="-9" r="6" fill="#2b2b2b"/>' +
      '<circle cx="-2.5" cy="-11" r="1.4" fill="#ff3b3b"/><circle cx="2.5" cy="-11" r="1.4" fill="#ff3b3b"/>' +
      '</svg>';
    document.body.append(thread, sp);
  });
}

export async function moveCursor(page, x, y) {
  await page.evaluate(([x, y]) => {
    const s = document.getElementById('__spider'), t = document.getElementById('__thread');
    if (!s || !t) return;
    const px = parseFloat(s.dataset.x ?? s.style.left), py = parseFloat(s.dataset.y ?? s.style.top);
    if (Math.hypot(x - px, y - py) > 4)
      s.firstElementChild.style.transform = 'rotate(' + (Math.atan2(y - py, x - px) * 180 / Math.PI + 90) + 'deg)';
    s.style.left = x + 'px'; s.style.top = y + 'px';
    t.style.left = x + 'px'; t.style.height = y + 'px';
    s.dataset.x = x; s.dataset.y = y;
  }, [x, y]);
  await sleep(FAST ? 200 : 700);
}
