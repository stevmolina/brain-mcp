// Drives the live page for a capture: real clicks and typing through the page's own
// handlers, and a log of where and when each action happened (CSS px, ms) for the
// film's cursor overlay. Paste into the page, then call one of the flows in flows.js.
window.__d = {
  t0: performance.now(),
  log: [],
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  box(el) { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; },
  mark(kind, name, el) { this.log.push({ t: Math.round(performance.now() - this.t0), kind, name, ...this.box(el) }); },
  async point(el, name, travel = 650) { this.mark('move', name, el); await this.wait(travel); },
  async click(el, name) { await this.point(el, name); this.mark('click', name, el); el.click(); },
  async type(el, text, name, every = 75) {
    await this.point(el, name); this.mark('click', name, el); el.focus();
    for (const ch of text) { el.value += ch; el.dispatchEvent(new Event('input', { bubbles: true })); await this.wait(every); }
  },
  async pick(el, value, name) {
    await this.point(el, name); this.mark('click', name, el);
    el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  },
};
