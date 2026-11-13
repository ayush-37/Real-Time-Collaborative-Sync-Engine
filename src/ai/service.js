// AI service: the guard rails that make an LLM call safe to run inside a server.
//   size cap, rate limit, timeout, partial failure, output clipping.
// `chains` = { conflicts(event) -> { coherent, conflicts[] }, changelog(event) -> { summary, changes[] } }
// The real chains live in chains.js (LangChain). Tests inject fakes, so `npm test` never calls an API.
//
// Design rule: AI OBSERVES, the CRDT DECIDES. Nothing here can touch the document; the output is a report.
const clip = (value, max) => String(value ?? '').slice(0, max);

// never trust model output blindly: bounded sizes, known enums (the UI also uses textContent only)
function cleanConflicts(raw) {
  const list = Array.isArray(raw?.conflicts) ? raw.conflicts : [];
  const conflicts = list.slice(0, 5).map((c) => ({
    kind: clip(c?.kind, 30),
    severity: ['low', 'medium', 'high'].includes(c?.severity) ? c.severity : 'medium',
    description: clip(c?.description, 300),
    evidence: clip(c?.evidence, 200),
    suggestion: clip(c?.suggestion, 300),
  }));
  return { coherent: raw?.coherent === true && conflicts.length === 0, conflicts };
}

function cleanChangelog(raw) {
  const list = Array.isArray(raw?.changes) ? raw.changes : [];
  return {
    summary: clip(raw?.summary, 400),
    changes: list.slice(0, 8).map((c) => ({
      side: c?.side === 'remote' ? 'remote' : 'local',
      description: clip(c?.description, 200),
    })),
  };
}

export function createAiService({ chains, maxChars = 6000, maxPerMinute = 6, timeoutMs = 30_000 }) {
  const stamps = [];
  const allow = () => {
    const now = Date.now();
    while (stamps.length > 0 && now - stamps[0] > 60_000) stamps.shift();
    if (stamps.length >= maxPerMinute) return false;
    stamps.push(now);
    return true;
  };

  const run = (fn) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI call timed out')), timeoutMs);
    });
    return Promise.race([Promise.resolve().then(fn), timeout]).finally(() => clearTimeout(timer));
  };

  return {
    async analyzeMerge(event) {
      if ([event.base, event.local, event.remote, event.merged].some((t) => t.length > maxChars)) {
        return { status: 'skipped', reason: `document longer than ${maxChars} characters` };
      }
      if (!allow()) return { status: 'skipped', reason: 'rate limit reached, try again later' };

      // two independent chains in parallel; one failing must not throw away the other
      const [conflicts, changelog] = await Promise.allSettled([
        run(() => chains.conflicts(event)),
        run(() => chains.changelog(event)),
      ]);
      if (conflicts.status === 'rejected' && changelog.status === 'rejected') {
        console.error('[ai] both chains failed:', conflicts.reason?.message);
        return { status: 'error', reason: 'the AI call failed' };
      }
      return {
        status: 'done',
        ...(conflicts.status === 'fulfilled' ? cleanConflicts(conflicts.value) : { coherent: null, conflicts: [] }),
        changelog: changelog.status === 'fulfilled' ? cleanChangelog(changelog.value) : null,
      };
    },
  };
}