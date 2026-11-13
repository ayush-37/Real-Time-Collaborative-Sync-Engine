// "AI review" panel: shows the reports the server produced after reconnect merges.
// Every string here comes from an LLM that has read user text, so it is ONLY put into the page
// with textContent (never innerHTML).
export function mountAiPanel({ docId, parent = document.body, pollMs = 5000 }) {
  const box = document.createElement('details');
  const summary = document.createElement('summary');
  const body = document.createElement('div');
  box.append(summary, body);
  parent.append(box);
  let lastSeen = 0;
  let latestId = 0;

  const el = (tag, text, style) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (style) node.style.cssText = style;
    return node;
  };

  function card(r) {
    const div = document.createElement('div');
    div.style.cssText = 'border-top:1px solid #8884;padding:6px 0';
    div.append(el('strong', `${new Date(r.at).toLocaleTimeString()} · reconnect by ${r.site}`));
    if (r.status === 'pending') {
      div.append(el('div', 'analysing…'));
    } else if (r.status !== 'done') {
      div.append(el('div', `not analysed: ${r.reason ?? r.status}`));
    } else {
      if (r.changelog?.summary) div.append(el('div', r.changelog.summary));
      for (const c of r.changelog?.changes ?? []) {
        div.append(el('div', `• ${c.side === 'remote' ? 'others' : 'reconnecting editor'}: ${c.description}`));
      }
      if (r.coherent === true) div.append(el('div', '✓ the merged text looks coherent'));
      for (const c of r.conflicts ?? []) {
        div.append(el('div', `⚠ [${c.severity}] ${c.description}`, 'margin-top:4px'));
        if (c.evidence) div.append(el('div', `“${c.evidence}”`, 'opacity:.7'));
        if (c.suggestion) div.append(el('div', `Suggestion: ${c.suggestion}`));
      }
    }
    return div;
  }

  function render(enabled, reports) {
    latestId = reports.reduce((m, r) => Math.max(m, r.id), 0);
    const unseen = reports.filter((r) => r.id > lastSeen && r.status === 'done' && r.coherent === false).length;
    summary.textContent = unseen > 0 && !box.open ? `AI review (${unseen} new)` : 'AI review';
    if (!enabled) {
      body.replaceChildren(el('p', 'AI review is switched off on this server.'));
    } else if (reports.length === 0) {
      body.replaceChildren(el('p', 'Nothing yet. A review appears after a reconnect in which two people edited at the same time.'));
    } else {
      body.replaceChildren(...[...reports].reverse().map(card));
    }
  }

  async function refresh() {
    try {
      const res = await fetch(`/ai/reports?doc=${encodeURIComponent(docId)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { enabled, reports } = await res.json();
      render(Boolean(enabled), Array.isArray(reports) ? reports : []);
    } catch { /* offline: the next tick tries again */ }
  }

  box.addEventListener('toggle', () => {
    if (box.open) lastSeen = latestId;
    refresh();
  });
  setInterval(refresh, pollMs);
  refresh();
}