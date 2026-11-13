// Roster of the people in the document. Every string here came from ANOTHER user, so it is only ever
// put into the page with textContent (never innerHTML): a name like "<img onerror=...>" must stay text.
import { resolvePeer } from './presence-model.js';

export function mountPresence({ doc, presence, parent = document.body }) {
  const box = document.createElement('div');
  parent.append(box);
  let queued = false;

  function render() {
    queued = false;
    const title = document.createElement('strong');
    title.textContent = `Online (${presence.peers.length + 1})`;
    const rows = presence.peers.map((peer) => {
      const r = resolvePeer(doc, peer);
      const dot = document.createElement('span');
      dot.textContent = '●';
      dot.style.color = peer.color;
      const label = document.createElement('span');
      let where = '';
      if (r.state === 'ready') {
        where = ` · line ${r.line}, col ${r.col}`;
        if (r.start !== r.end) where += ` · ${Math.abs(r.end - r.start)} selected`;
      } else if (r.state === 'pending') {
        where = ' · catching up';
      }
      label.textContent = ` ${peer.name}${where}`;
      const row = document.createElement('div');
      row.append(dot, label);
      return row;
    });
    box.replaceChildren(title, ...rows);
  }

  // re-resolve when the roster changes AND when the document changes (a 'pending' cursor may now resolve)
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(render);
  };
  presence.onPeers(schedule);
  doc.onChange(schedule);
  schedule();
}