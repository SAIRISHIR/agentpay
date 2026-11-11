'use strict';

// Live map of the agent economy. Every particle is a real payment event; nothing travels without one.
// Layout: buyer agents on the left, the escrow hub in the middle with PayPal above it inside a
// PayPal-blue light beam, and sellers on the right in two staggered columns grouped by type of work.
// Routes glow for a few seconds after money moves along them; hovering a node shows its details.
(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const usd = c => `$${((Number(c) || 0) / 100).toFixed(2)}`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  // '#009cde' + alpha → 'rgba(0,156,222,a)'. Non-hex colours pass through unchanged.
  const rgba = (hex, a) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    const s = m[1].length === 3 ? m[1].replace(/./g, ch => ch + ch) : m[1];
    const n = parseInt(s, 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  const SANS = 'Inter, system-ui, sans-serif';
  const MONO = '"JetBrains Mono", ui-monospace, monospace';

  class AgentNetwork {
    constructor(canvas, caption) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.caption = caption;
      this.buyers = [];
      this.sellers = [];
      this.clusters = [];
      this.particles = [];
      this.flashes = new Map();
      this.heat = new Map();
      this.hover = null;
      this.hub = { id: 'hub', kind: 'hub', label: 'Escrow + quality check', sub: 'Nothing held', r: 28 };
      this.paypal = { id: 'paypal', kind: 'paypal', label: 'PayPal', sub: '0 transactions', r: 22 };
      this.colors = {};
      this.tip = document.createElement('div');
      this.tip.className = 'net-tip';
      this.tip.hidden = true;
      canvas.parentElement.appendChild(this.tip);
      this.readColors();
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.readColors());
      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener('pointermove', e => this.onPointer(e));
      canvas.addEventListener('pointerleave', () => this.setHover(null));
      this.resize();
      this.frame = this.frame.bind(this);
      requestAnimationFrame(this.frame);
    }

    readColors() {
      const s = getComputedStyle(document.documentElement);
      for (const k of ['ink', 'ink-2', 'ink-3', 'line', 'card', 'fill', 'fill-2', 'good', 'bad', 'warn', 'live', 'bg', 'accent']) {
        this.colors[k] = s.getPropertyValue(`--${k}`).trim() || '#888';
      }
      this.dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this.paintGlow();
    }

    resize() {
      const r = this.c.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = r.width;
      this.h = r.height;
      this.c.width = Math.max(1, Math.round(r.width * dpr));
      this.c.height = Math.max(1, Math.round(r.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.layout();
    }

    // buyers: [{id,name,glyph,role}], sellers: [{id,name,glyph,category,group,services}]
    setAgents(buyers, sellers) {
      const keep = (list, prev) => list.map(n => ({ passRate: null, judged: 0, suspended: false, earned: 0, ...prev.find(p => p.id === n.id), ...n }));
      this.buyers = keep(buyers.map(b => ({ ...b, kind: 'buyer' })), this.buyers);
      // Keep each type of work together so the clusters read as departments.
      const order = [];
      for (const s of sellers) if (!order.includes(s.group || 'Other')) order.push(s.group || 'Other');
      const sorted = [...sellers].sort((a, b) => order.indexOf(a.group || 'Other') - order.indexOf(b.group || 'Other'));
      this.sellers = keep(sorted.map(s => ({ ...s, kind: 'seller' })), this.sellers);
      this.layout();
    }

    updateSeller(id, patch) {
      const s = this.sellers.find(x => x.id === id);
      if (!s) return;
      Object.assign(s, patch);
      s.r = this.sellerRadius(s);
    }

    setHub(sub) { this.hub.sub = sub; }
    setPayPal(sub) { this.paypal.sub = sub; }

    sellerRadius(s) {
      const base = this.narrow ? 10 : 12;
      return base + Math.min(5, Math.sqrt(Math.max(0, s.earned || 0)) * 0.9);
    }

    layout() {
      const { w, h } = this;
      if (!w || !h) return;
      this.narrow = w < 620;
      const top = 26, bottom = h - 22;
      const spread = (arr, from, to) => arr.forEach((n, i) => { n.y = arr.length === 1 ? (from + to) / 2 : from + (i / (arr.length - 1)) * (to - from); });

      // Buyers: one column on the left, labels to the right.
      const bx = this.narrow ? 24 : Math.max(26, w * 0.05);
      spread(this.buyers, top + 8, bottom - 8);
      this.buyers.forEach(b => { b.x = bx; b.r = this.narrow ? 12 : 15; });

      // Hub and PayPal share the centre line; the beam runs between them.
      const cx = this.narrow ? w * 0.47 : w * 0.43;
      Object.assign(this.hub, { x: cx, y: h * 0.6, r: this.narrow ? 22 : 28 });
      Object.assign(this.paypal, { x: cx, y: Math.max(48, h * 0.14), r: this.narrow ? 18 : 22 });

      // Sellers: two staggered columns on wide screens, one on phones.
      const n = this.sellers.length;
      const twoCols = !this.narrow && n > 9;
      const xA = this.narrow ? w * 0.72 : w * (twoCols ? 0.63 : 0.72);
      const xB = w * 0.8;
      spread(this.sellers, top, bottom);
      this.sellers.forEach((s, i) => {
        s.col = twoCols ? i % 2 : 0;
        s.x = s.col ? xB : xA;
        s.r = this.sellerRadius(s);
      });
      this.cols = { twoCols, xA, xB };

      // Cluster brackets: one per type of work, drawn left of the seller columns.
      this.clusters = [];
      for (const s of this.sellers) {
        const g = s.group || 'Other';
        const last = this.clusters[this.clusters.length - 1];
        if (last && last.group === g) { last.y2 = s.y; last.count += 1; } else this.clusters.push({ group: g, y1: s.y, y2: s.y, count: 1 });
      }
      this.paintGlow();
    }

    node(id) {
      if (id === 'hub') return this.hub;
      if (id === 'paypal') return this.paypal;
      return this.buyers.find(b => b.id === id) || this.sellers.find(s => s.id === id) || null;
    }

    narrate(text) { if (this.caption) this.caption.textContent = text; }

    flash(id, color) { this.flashes.set(id, { color, t: 1 }); }

    warm(a, b, color) {
      const key = [a.id, b.id].sort().join('|');
      const cur = this.heat.get(key);
      this.heat.set(key, { v: Math.min(3, (cur?.v || 0) + 1), color });
    }

    send(fromId, toId, color, { size = 4, speed = 0.022 } = {}) {
      const a = this.node(fromId), b = this.node(toId);
      if (!a || !b) return;
      this.warm(a, b, color);
      if (reduceMotion || document.hidden) { this.flash(toId, color); return; }
      this.particles.push({ a, b, color, size, speed, t: 0, toId });
      if (this.particles.length > 80) this.particles.splice(0, this.particles.length - 80);
    }

    // Translate escrow status changes into motion.
    onEscrow(e, prev) {
      if (prev === e.status) return;
      const buyer = this.node(e.channel) ? e.channel : 'api';
      const C = this.colors;
      const who = e.buyerName || 'An agent';
      switch (e.status) {
        case 'held':
          if (!prev) { this.send(buyer, 'hub', C.live); this.narrate(`${who} is buying ${e.serviceName} from ${e.sellerName} for ${usd(e.priceCents)}`); }
          break;
        case 'awaiting_approval':
          this.flash('hub', C.warn);
          this.narrate(`${who} needs your OK to spend ${usd(e.priceCents)} on ${e.serviceName}`);
          break;
        case 'locked': this.send('hub', e.sellerId, C.live); break;
        case 'delivered': this.send(e.sellerId, 'hub', C['ink-2'], { size: 3 }); break;
        case 'released':
          this.send('hub', e.sellerId, C.good, { size: 6 });
          this.narrate(`Quality check passed: ${usd(e.priceCents)} paid to ${e.sellerName} for ${e.serviceName}`);
          break;
        case 'refunded':
          this.flash(e.sellerId, C.warn);
          this.send('hub', buyer, C.warn, { size: 6 });
          this.narrate(`Quality check failed: ${usd(e.priceCents)} refunded from ${e.sellerName}`);
          break;
        case 'blocked':
          this.flash(e.sellerId, C.bad);
          this.flash(buyer, C.bad);
          this.narrate(`Blocked: ${(e.timeline?.[e.timeline.length - 1]?.note || 'outside your limits').replace(/\.$/, '')}`);
          break;
        case 'rejected':
          this.flash('hub', C['ink-3']);
          this.narrate(`Purchase not approved: ${e.serviceName} from ${e.sellerName}`);
          break;
        default: break;
      }
    }

    onSettlement(s) {
      const C = this.colors;
      if (s.kind === 'capture') { this.send('paypal', 'hub', C.good, { size: 8, speed: 0.016 }); this.narrate(`PayPal top-up captured: ${usd(s.cents)}`); }
      if (s.kind === 'refund' && s.status !== 'failed') { this.send('hub', 'paypal', C.warn, { size: 7, speed: 0.016 }); this.narrate(`Unspent ${usd(s.cents)} refunded to you`); }
      if (s.kind === 'payout' && !s.updatedAt) {
        this.send('hub', 'paypal', C.good, { size: 8, speed: 0.016 });
        const paid = this.sellers.filter(x => x.earned > 0);
        setTimeout(() => paid.forEach(x => this.send('paypal', x.id, C.good, { size: 5, speed: 0.014 })), reduceMotion ? 0 : 900);
        this.narrate(`One PayPal batch pays ${paid.length} sellers ${usd(s.cents)} for approved work`);
      }
    }

    /* ---------- Hover details ---------- */
    onPointer(e) {
      const r = this.c.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bestD = Infinity;
      for (const n of [this.hub, this.paypal, ...this.buyers, ...this.sellers]) {
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < n.r + 10 && d < bestD) { best = n; bestD = d; }
      }
      this.setHover(best);
    }

    setHover(n) {
      if (this.hover === n) return;
      this.hover = n;
      this.c.style.cursor = n ? 'help' : '';
      if (!n) { this.tip.hidden = true; return; }
      let rows;
      if (n.kind === 'seller') {
        rows = [
          ['Type of work', n.group || n.category],
          ['Services', n.services ?? '—'],
          ['Quality', n.judged ? `${Math.round(n.passRate * 100)}% passed (${n.judged} checked)` : 'No history yet'],
          ['Earned', usd(n.earned)],
          ['Status', n.suspended ? 'Suspended by the risk engine' : 'Active'],
        ];
      } else if (n.kind === 'buyer') {
        rows = [['Job', n.role], ['Pays from', 'Your PayPal-funded wallet']];
      } else if (n.kind === 'hub') {
        rows = [['Now', n.sub], ['Rule', 'Money is released only when the work passes the AI check']];
      } else {
        rows = [['Settled', n.sub], ['Role', 'Funds the wallet, pays sellers in one batch, refunds leftovers']];
      }
      const title = n.kind === 'seller' ? `${n.name} · ${n.category}` : n.kind === 'buyer' ? n.name : n.label;
      this.tip.innerHTML = `<b>${esc(title)}</b>${rows.map(([k, v]) => `<span><i>${esc(k)}</i>${esc(v)}</span>`).join('')}`;
      this.tip.hidden = false;
      const card = this.c.parentElement.getBoundingClientRect();
      const cr = this.c.getBoundingClientRect();
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      let left = cr.left - card.left + n.x + n.r + 12;
      if (left + tw > card.width - 8) left = cr.left - card.left + n.x - n.r - 12 - tw;
      const topPx = Math.min(card.height - th - 8, Math.max(8, cr.top - card.top + n.y - th / 2));
      this.tip.style.left = `${Math.max(8, left)}px`;
      this.tip.style.top = `${topPx}px`;
    }

    related(n) {
      if (!this.hover) return true;
      const h = this.hover;
      if (n === h) return true;
      if (h.kind === 'hub') return true;
      if (h.kind === 'paypal') return n.kind === 'hub' || n.kind === 'paypal' || (n.kind === 'seller' && n.earned > 0);
      return n.kind === 'hub';
    }

    /* ---------- Drawing ---------- */
    // The PayPal-blue light beam: rises from the escrow hub up through the PayPal node, like a spotlight
    // on the money rail. Painted once per resize or theme change, then copied into every frame.
    paintGlow() {
      const { w, h } = this;
      if (!w || !h || !this.hub.x) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const g = this.glow || (this.glow = document.createElement('canvas'));
      g.width = Math.round(w * dpr);
      g.height = Math.round(h * dpr);
      const x = g.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      const a = this.colors.accent;
      const k = this.dark ? 1 : 0.55;
      const cx = this.hub.x;
      const bw = Math.min(w * 0.13, 120);

      const body = x.createLinearGradient(cx - bw, 0, cx + bw, 0);
      body.addColorStop(0, rgba(a, 0));
      body.addColorStop(0.5, rgba(a, 0.30 * k));
      body.addColorStop(1, rgba(a, 0));
      x.fillStyle = body;
      x.fillRect(cx - bw, 0, bw * 2, h);
      const rays = [-0.78, -0.55, -0.36, -0.2, -0.08, 0.05, 0.17, 0.31, 0.48, 0.66, 0.84];
      rays.forEach((r, i) => {
        x.fillStyle = rgba(a, (0.10 + (i % 3) * 0.06) * k * (1 - Math.abs(r) * 0.7));
        x.fillRect(cx + r * bw, 0, i % 2 ? 1 : 2, h);
      });
      x.globalCompositeOperation = 'destination-in';
      const fade = x.createLinearGradient(0, 0, 0, h);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(Math.max(0.01, this.paypal.y / h - 0.06), 'rgba(0,0,0,0.35)');
      fade.addColorStop(this.hub.y / h, 'rgba(0,0,0,1)');
      fade.addColorStop(1, 'rgba(0,0,0,0.25)');
      x.fillStyle = fade;
      x.fillRect(0, 0, w, h);
      x.globalCompositeOperation = 'source-over';

      const pool = (px, py, r, alpha) => {
        const p = x.createRadialGradient(px, py, 0, px, py, r);
        p.addColorStop(0, rgba(a, alpha * k));
        p.addColorStop(1, rgba(a, 0));
        x.fillStyle = p;
        x.fillRect(px - r, py - r, r * 2, r * 2);
      };
      pool(cx, this.hub.y, Math.min(w * 0.22, 170), 0.32);
      pool(this.paypal.x, this.paypal.y, 70, 0.28);
    }

    curve(a, b) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      return { cx: mx - dy * 0.12, cy: my + dx * 0.12 };
    }

    point(a, b, t) {
      const { cx, cy } = this.curve(a, b);
      const u = 1 - t;
      return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y };
    }

    edge(a, b, color, width = 1, dash = []) {
      const { ctx } = this;
      const { cx, cy } = this.curve(a, b);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    // A route between two nodes: a hairline at rest, glowing in the colour of the last payment while warm.
    route(a, b, { dash = [], rest } = {}) {
      const C = this.colors;
      const heat = this.heat.get([a.id, b.id].sort().join('|'));
      const lit = this.hover && (this.hover === a || this.hover === b || this.hover.kind === 'hub');
      const dim = this.hover && !lit;
      this.ctx.save();
      if (dim) this.ctx.globalAlpha = 0.35;
      this.edge(a, b, rest || C.line, 1, dash);
      if (lit) this.edge(a, b, rgba(C.accent, 0.55), 1.25, dash);
      if (heat && heat.v > 0.03) {
        this.ctx.shadowColor = heat.color;
        this.ctx.shadowBlur = 8;
        this.edge(a, b, rgba(heat.color, Math.min(0.85, 0.2 + heat.v * 0.3)), 1 + Math.min(2, heat.v * 0.7), dash);
      }
      this.ctx.restore();
    }

    fit(text, max) {
      const { ctx } = this;
      const t = String(text ?? '');
      if (max <= 12) return '';
      if (ctx.measureText(t).width <= max) return t;
      let lo = 0, hi = t.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(`${t.slice(0, mid)}…`).width <= max) lo = mid; else hi = mid - 1;
      }
      return lo ? `${t.slice(0, lo)}…` : '';
    }

    labelRoom(n) {
      if (n.kind === 'buyer') return this.hub.x - this.hub.r - n.x - n.r - 26;
      if (n.kind === 'seller') return n.col === 0 && this.cols.twoCols ? this.cols.xB - n.x - n.r - 22 : this.w - n.x - n.r - 12;
      return 200;
    }

    drawNode(n, { glyph, label, sub, labelSide = 'below', subColor, accent = false }) {
      const { ctx, colors: C } = this;
      const f = this.flashes.get(n.id);
      ctx.save();
      if (!this.related(n)) ctx.globalAlpha = 0.35;
      if (f) {
        ctx.save();
        ctx.globalAlpha *= f.t * 0.9;
        ctx.strokeStyle = f.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 6 + (1 - f.t) * 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.fillStyle = C.card;
      ctx.strokeStyle = n.suspended ? C.bad : accent || this.hover === n ? C.accent : C['ink-3'];
      ctx.lineWidth = n.suspended || accent || this.hover === n ? 1.75 : 1;
      if (n.suspended) ctx.setLineDash([3, 3]);
      if (accent || this.hover === n) { ctx.shadowColor = C.accent; ctx.shadowBlur = 22; }
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.stroke();
      ctx.restore();

      if (n.kind === 'seller' && n.judged > 0) {
        ctx.save();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = C.good;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * n.passRate);
        ctx.stroke();
        ctx.strokeStyle = C.warn;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 4, -Math.PI / 2 + Math.PI * 2 * n.passRate, Math.PI * 1.5);
        ctx.stroke();
        ctx.restore();
      }

      ctx.fillStyle = accent ? C.accent : C.ink;
      ctx.font = `600 ${n.r > 20 ? 12 : n.r > 12 ? 10 : 9}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph, n.x, n.y + 0.5);

      ctx.textBaseline = 'alphabetic';
      const nameSize = this.narrow ? 11.5 : 12.5;
      if (labelSide === 'right') {
        const room = this.labelRoom(n);
        const lx = n.x + n.r + (n.judged ? 10 : 8);
        ctx.textAlign = 'left';
        ctx.font = `600 ${nameSize}px ${SANS}`;
        ctx.fillStyle = C.ink;
        ctx.fillText(this.fit(label, room), lx, sub && !this.narrow ? n.y - 1 : n.y + 4);
        if (sub && !this.narrow) {
          ctx.font = `11px ${SANS}`;
          ctx.fillStyle = subColor || C['ink-2'];
          ctx.fillText(this.fit(sub, room), lx, n.y + 12);
        }
      } else {
        ctx.textAlign = 'center';
        ctx.font = `600 ${nameSize}px ${SANS}`;
        ctx.fillStyle = C.ink;
        ctx.fillText(label, n.x, n.y + n.r + 16);
        ctx.font = `11px ${SANS}`;
        ctx.fillStyle = subColor || C['ink-2'];
        ctx.fillText(sub, n.x, n.y + n.r + 30);
      }
      ctx.restore();
    }

    drawClusters() {
      if (this.narrow || !this.clusters.length) return;
      const { ctx, colors: C } = this;
      const x = this.cols.xA - 34;
      ctx.save();
      for (const c of this.clusters) {
        const y1 = c.y1 - 10, y2 = c.y2 + 10;
        ctx.strokeStyle = rgba(C.accent, 0.35);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 5, y1); ctx.lineTo(x, y1); ctx.lineTo(x, y2); ctx.lineTo(x + 5, y2);
        ctx.stroke();
        if (y2 - y1 > 44) {
          ctx.save();
          ctx.translate(x - 7, (y1 + y2) / 2);
          ctx.rotate(-Math.PI / 2);
          ctx.font = `600 10.5px ${SANS}`;
          ctx.fillStyle = C['ink-2'];
          ctx.textAlign = 'center';
          ctx.fillText(this.fit(c.group, y2 - y1 - 6), 0, 0);
          ctx.restore();
        }
      }
      ctx.restore();
    }

    frame() {
      const { ctx, colors: C, w, h } = this;
      if (w && h) {
        ctx.clearRect(0, 0, w, h);
        const now = performance.now();
        const breathe = reduceMotion ? 0 : (Math.sin(now / 900) + 1) / 2;

        if (this.glow) {
          ctx.save();
          ctx.globalAlpha = 0.82 + ((Math.sin(now / 2600) + 1) / 2) * (reduceMotion ? 0 : 0.18);
          ctx.drawImage(this.glow, 0, 0, w, h);
          ctx.restore();
        }

        this.drawClusters();
        for (const b of this.buyers) this.route(b, this.hub);
        for (const s of this.sellers) this.route(this.hub, s, s.suspended ? { dash: [4, 4], rest: rgba(C.bad, 0.5) } : {});
        this.route(this.hub, this.paypal, { dash: [6, 5], rest: rgba(C.accent, 0.75) });

        // Escrow vault: a slow dashed ring around the hub and a breathing halo.
        ctx.save();
        ctx.strokeStyle = C.accent;
        ctx.globalAlpha = 0.22 + breathe * 0.14;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(this.hub.x, this.hub.y, this.hub.r + 10 + breathe * 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([2, 6]);
        ctx.lineDashOffset = reduceMotion ? 0 : -now / 60;
        ctx.beginPath();
        ctx.arc(this.hub.x, this.hub.y, this.hub.r + 20, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        this.particles = this.particles.filter(p => {
          p.t += p.speed;
          if (p.t >= 1) { this.flash(p.toId, p.color); return false; }
          for (let k = 3; k >= 0; k--) {
            const q = this.point(p.a, p.b, Math.max(0, p.t - k * 0.025));
            ctx.save();
            ctx.globalAlpha = k === 0 ? 1 : 0.18 * (4 - k) / 3;
            ctx.fillStyle = p.color;
            if (k === 0) { ctx.shadowColor = p.color; ctx.shadowBlur = 14; }
            ctx.beginPath();
            ctx.arc(q.x, q.y, k === 0 ? p.size : p.size * 0.7, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
          return true;
        });

        for (const [id, f] of this.flashes) { f.t -= 0.02; if (f.t <= 0) this.flashes.delete(id); }
        for (const [k, v] of this.heat) { v.v *= 0.994; if (v.v < 0.02) this.heat.delete(k); }

        this.drawNode(this.paypal, { glyph: 'PP', label: 'PayPal', sub: this.paypal.sub, accent: true });
        this.drawNode(this.hub, { glyph: 'ESC', label: this.narrow ? 'Escrow' : this.hub.label, sub: this.hub.sub });
        for (const b of this.buyers) this.drawNode(b, { glyph: b.glyph, label: b.name, sub: b.role, labelSide: 'right' });
        for (const s of this.sellers) {
          const sub = s.suspended ? 'Suspended by risk engine' : s.judged ? `${Math.round(s.passRate * 100)}% pass · ${s.category}` : s.category;
          this.drawNode(s, { glyph: s.glyph, label: s.name, sub, labelSide: 'right', subColor: s.suspended ? C.bad : null });
        }
      }
      requestAnimationFrame(this.frame);
    }
  }

  window.AgentNetwork = AgentNetwork;
})();
