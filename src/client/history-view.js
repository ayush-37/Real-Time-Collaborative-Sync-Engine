// A "time machine" panel: a slider over the document's history, a preview of the chosen moment,
// and a button that reverts to it. Browser-only (uses the DOM).
import { timeline, textAt, revertTo } from '../doc/history.js';

export function mountHistory({ doc, parent = document.body }) {
  const box = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'History';
  const slider = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 0, value: 0 });
  const label = document.createElement('div');
  const preview = document.createElement('pre');
  const revertBtn = Object.assign(document.createElement('button'), { textContent: 'Revert to this point' });
  box.append(summary, slider, label, preview, revertBtn);
  parent.append(box);

  let runs = [];
  const opsAtStep = (step) => (step === 0 ? 0 : runs[step - 1].end);

  function show() {
    const step = Number(slider.value);
    const n = opsAtStep(step);
    const run = step === 0 ? null : runs[step - 1];
    label.textContent = run
      ? `step ${step}/${runs.length}: ${run.site} ${run.type === 'insert' ? 'typed' : 'deleted'} ${run.count} char(s)`
      : `step 0/${runs.length}: empty document`;
    preview.textContent = textAt(doc.log, n);
  }

  // refreshed when the panel is opened and after a revert, NOT on every keystroke,
  // so the slider does not jump while you are dragging it
  function refresh() {
    runs = timeline(doc.log);
    slider.max = runs.length;
    slider.value = runs.length;
    show();
  }

  slider.addEventListener('input', show);
  box.addEventListener('toggle', () => { if (box.open) refresh(); });
  revertBtn.addEventListener('click', () => {
    revertTo(doc, opsAtStep(Number(slider.value))); // a normal local edit: SyncClient sends it, other tabs get it
    refresh();
  });
}