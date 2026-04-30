// Simple localStorage-backed sync queue for save/markCollected operations.
// Each entry: { id, kind: 'saveScan' | 'markCollected', payload, addedAt, attempts }

const KEY = 'syncQueue.v1';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
  catch { return []; }
}
function write(q) { localStorage.setItem(KEY, JSON.stringify(q)); }

export function getQueue() { return read(); }

export function queueSize() { return read().length; }

export function enqueue(kind, payload) {
  const q = read();
  q.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    kind,
    payload,
    addedAt: new Date().toISOString(),
    attempts: 0,
  });
  write(q);
  return q.length;
}

export function clearOne(id) {
  write(read().filter(e => e.id !== id));
}

export function bumpAttempt(id) {
  const q = read();
  const e = q.find(x => x.id === id);
  if (e) { e.attempts += 1; write(q); }
}

// Drain the queue with a runner function. Returns { processed, remaining }.
// runner(entry) → Promise<{ ok: boolean }>. Successful entries are removed.
export async function drainQueue(runner) {
  const q = read();
  let processed = 0;
  for (const entry of q) {
    try {
      const res = await runner(entry);
      if (res?.ok) {
        clearOne(entry.id);
        processed += 1;
      } else {
        bumpAttempt(entry.id);
        // Stop on first failure — preserve order, retry next online event
        break;
      }
    } catch {
      bumpAttempt(entry.id);
      break;
    }
  }
  return { processed, remaining: queueSize() };
}
