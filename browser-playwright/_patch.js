(() => {
  const views = [...document.querySelectorAll("webview")];
  const view = views.find(v => (v.getTitle() || "").includes("dshpg-6cafe3-2b9a0ccd"));
  if (!view) return JSON.stringify({ error: "not found" });
  const visible = views.find(v => { const r = v.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const box = visible ? visible.getBoundingClientRect() : { width: 900, height: 700 };
  const saved = [];
  const patch = (node, css) => { saved.push({ node, css: node.style.cssText }); Object.assign(node.style, css); };
  const chain = [];
  let n = view;
  let stop = false;
  while (n && n !== document.documentElement && chain.length < 12) {
    const cs = getComputedStyle(n);
    chain.push({ i: chain.length, tag: n.tagName.toLowerCase(), cls: String(n.className || "").slice(0, 22), h: cs.height, maxH: cs.maxHeight, display: cs.display });
    if (!stop) {
      patch(n, { width: "100%", height: "100%", minHeight: "0px", maxHeight: "none" });
      if (cs.display === "none") {
        Object.assign(n.style, { position: "fixed", left: "0px", top: "0px", width: Math.round(box.width) + "px", height: Math.round(box.height) + "px", display: "block", zIndex: "-1" });
      }
      if (String(n.className || "").includes("tabCell")) stop = true;
    }
    n = n.parentElement;
  }
  window.__dshCaptureProbe = saved;
  const r = view.getBoundingClientRect();
  const after = chain.map((c) => { const cs = getComputedStyle(saved[c.i] ? saved[c.i].node : view); return c.i + ":" + Math.round((saved[c.i] ? saved[c.i].node : view).getBoundingClientRect().height); });
  return JSON.stringify({ patched: saved.length, rect: { w: Math.round(r.width), h: Math.round(r.height) }, box: { w: Math.round(box.width), h: Math.round(box.height) }, chain, after });
})()
