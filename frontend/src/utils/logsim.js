// 日志空间沙盘引擎：主库复制日志有空间上限，覆盖追加、副本追赶、全量重建与写入等待。
// 纯计算模型，不碰 DOM、不连真实集群；浏览器页面与 Node 单测共用同一口径。

export const SIM_DEFAULTS = {
  capacity: 3000,      // 日志空间上限（字节）
  rebuildTicks: 10,    // 全量重建所需 tick 数
  replicas: [
    { id: 'R1', key: true,  rate: 150 },  // 重点副本：未确认的日志必须保留
    { id: 'R2', key: false, rate: 120 },  // 普通副本：空间告急时可转全量重建
    { id: 'R3', key: false, rate: 130 },
  ],
};

export function createState(cfg = {}) {
  const replicas = (cfg.replicas || SIM_DEFAULTS.replicas).map(r => ({
    id: r.id,
    key: !!r.key,
    rate: r.rate,
    state: 'streaming',  // streaming=追赶中 | rebuilding=全量重建中
    confirmed: 0,        // 已确认（落盘）的日志位点
    paused: false,       // 暂停确认（位点仍钉住日志）
    progress: 0,         // 重建进度 0..100
    snapshotLsn: 0,      // 重建快照点位点
  }));
  return {
    capacity: cfg.capacity || SIM_DEFAULTS.capacity,
    rebuildTicks: cfg.rebuildTicks || SIM_DEFAULTS.rebuildTicks,
    head: 0,            // 下一个待分配的 LSN
    entries: [],        // 保留中的日志条目 {lsn,size,reqId}
    recycledBytes: 0,
    dedup: {},          // reqId -> lsn，已落盘写入的去重表
    pending: [],        // 等待空间的写入 {reqId,size,since}
    replicas,
    tick: 0,
    stats: { appended: 0, appendedBytes: 0, dupHits: 0, waits: 0 },
    lastWaitReason: '',
  };
}

export const usedBytes = st => st.entries.reduce((a, e) => a + e.size, 0);
export const freeBytes = st => st.capacity - usedBytes(st);
export const floorLsn = st => (st.entries.length ? st.entries[0].lsn : st.head);
export const lagOf = (st, r) => Math.max(0, st.head - r.confirmed);
export const isCandidate = r => r.state === 'streaming'; // 重建完成前不可参选

// 仍在钉住日志的副本：追赶中的（含已暂停）与重建中的（钉在快照点）
export const pinningReplicas = st =>
  st.replicas.filter(r => r.state === 'streaming' || r.state === 'rebuilding');

// 保留基线最多能推进到的位点
export function floorTarget(st) {
  const pins = pinningReplicas(st);
  if (!pins.length) return st.head;
  return Math.min(...pins.map(r => r.confirmed));
}

export function recyclableBytes(st) {
  const t = floorTarget(st);
  return st.entries.reduce((a, e) => (e.lsn + e.size <= t ? a + e.size : a), 0);
}

export function recycle(st, ev) {
  const t = floorTarget(st);
  let freed = 0, n = 0;
  while (st.entries.length && st.entries[0].lsn + st.entries[0].size <= t) {
    freed += st.entries[0].size; n++; st.entries.shift();
  }
  if (freed) {
    st.recycledBytes += freed;
    if (ev) ev.push({ type: 'recycle', text: `回收 ${n} 条日志，释放 ${freed}B，保留基线推进到 LSN ${floorLsn(st)}` });
  }
  return freed;
}

// 当前把保留基线钉在低位的副本（可能多个并列）
export function blockers(st) {
  const pins = pinningReplicas(st);
  if (!pins.length) return [];
  const m = Math.min(...pins.map(r => r.confirmed));
  return pins.filter(r => r.confirmed === m);
}

export function waitReason(st, size) {
  const need = size - freeBytes(st);
  if (need <= 0) return '空间已够，下一拍会自动写入';
  const bl = blockers(st);
  if (!bl.length) return `还差 ${need}B，但没有副本钉住日志，回收后即可写入`;
  const names = bl.map(r =>
    `${r.id}${r.key ? '（重点）' : ''}${r.state === 'rebuilding' ? '（重建中）' : ''}${r.paused ? '（已暂停）' : ''}`
  ).join('、');
  const tip = bl.some(r => !r.key && r.state === 'streaming')
    ? '普通副本可转全量重建来腾空间'
    : '重点副本未确认的日志必须保留，只能等它确认';
  return `还差 ${need}B：日志被 ${names} 钉在 LSN ${bl[0].confirmed}，${tip}`;
}

function appendEntry(st, reqId, size, ev, note) {
  const lsn = st.head;
  st.entries.push({ lsn, size, reqId });
  st.dedup[reqId] = lsn;
  st.head += size;
  st.stats.appended++; st.stats.appendedBytes += size;
  ev.push({ type: 'append', text: `${note || ''}${reqId} 落盘：LSN ${lsn}，占 ${size}B` });
  return lsn;
}

export function flushPending(st, ev = []) {
  while (st.pending.length) {
    const w = st.pending[0];
    if (freeBytes(st) < w.size) {
      const reason = waitReason(st, w.size);
      if (reason !== st.lastWaitReason) {
        st.lastWaitReason = reason;
        ev.push({ type: 'wait', text: `写入 ${w.reqId} 仍在等待：${reason}` });
      }
      return ev;
    }
    st.pending.shift();
    appendEntry(st, w.reqId, w.size, ev, '等待结束，');
    st.lastWaitReason = '';
  }
  return ev;
}

export function submitWrite(st, reqId, size) {
  const ev = [];
  // 已落盘的写入重试：命中去重表，不新增日志，也不多占空间
  if (st.dedup[reqId] !== undefined) {
    st.stats.dupHits++;
    ev.push({ type: 'dup', text: `重试 ${reqId}：已落盘于 LSN ${st.dedup[reqId]}，不新增日志、不占空间` });
    return { status: 'duplicate', lsn: st.dedup[reqId], events: ev };
  }
  if (st.pending.some(p => p.reqId === reqId)) {
    ev.push({ type: 'dup', text: `重试 ${reqId}：仍在等待队列中，不重复入队` });
    return { status: 'already-pending', events: ev };
  }
  if (size > st.capacity) {
    ev.push({ type: 'error', text: `写入 ${reqId}（${size}B）超过日志总容量 ${st.capacity}B，拒绝` });
    return { status: 'rejected', events: ev };
  }
  recycle(st, ev);
  flushPending(st, ev);
  if (st.pending.length) {
    st.pending.push({ reqId, size, since: st.tick });
    ev.push({ type: 'wait', text: `写入 ${reqId}（${size}B）排队：前方还有 ${st.pending.length - 1} 笔等待` });
    return { status: 'queued', events: ev };
  }
  if (freeBytes(st) >= size) {
    const lsn = appendEntry(st, reqId, size, ev);
    return { status: 'appended', lsn, events: ev };
  }
  st.pending.push({ reqId, size, since: st.tick });
  st.stats.waits++;
  const reason = waitReason(st, size);
  st.lastWaitReason = reason;
  ev.push({ type: 'wait', text: `写入 ${reqId}（${size}B）开始等待：${reason}` });
  return { status: 'queued', reason, events: ev };
}

// 一拍：副本确认与重建推进（与写入追加并发、互不阻塞），随后回收并唤醒等待写入
export function step(st, rng = Math.random) {
  const ev = [];
  st.tick++;
  for (const r of st.replicas) {
    if (r.state === 'streaming' && !r.paused) {
      const before = r.confirmed;
      const rate = Math.round(r.rate * (0.8 + 0.4 * rng()));
      r.confirmed = Math.min(st.head, r.confirmed + rate);
      if (st.head - before > r.rate && r.confirmed >= st.head)
        ev.push({ type: 'confirm', text: `${r.id} 追平主库（LSN ${st.head}）` });
    } else if (r.state === 'rebuilding') {
      r.progress = Math.min(100, r.progress + 100 / st.rebuildTicks);
      if (r.progress >= 100) {
        r.state = 'streaming';
        ev.push({ type: 'rebuild-done', text: `${r.id} 全量重建完成：从快照点 LSN ${r.snapshotLsn} 续追，恢复参选资格` });
      }
    }
  }
  recycle(st, ev);
  flushPending(st, ev);
  return ev;
}

// 普通副本转全量重建：旧追赶位点释放，快照点取当前头部；重建完成前不可参选
export function convertToRebuild(st, id) {
  const ev = [];
  const r = st.replicas.find(x => x.id === id);
  if (!r) return { ok: false, events: ev };
  if (r.key) {
    ev.push({ type: 'error', text: `${r.id} 是重点副本，未确认的日志必须保留，不能转全量重建` });
    return { ok: false, events: ev };
  }
  if (r.state !== 'streaming') {
    ev.push({ type: 'error', text: `${r.id} 已在重建中` });
    return { ok: false, events: ev };
  }
  r.state = 'rebuilding';
  r.snapshotLsn = st.head;
  r.confirmed = st.head; // 快照包含到当前位点，旧追赶位点即刻释放
  r.progress = 0;
  r.paused = false;
  ev.push({ type: 'rebuild', text: `${r.id} 转全量重建：快照点 LSN ${st.head}，旧追赶位点释放；重建完成前不可参选` });
  recycle(st, ev);
  flushPending(st, ev);
  return { ok: true, events: ev };
}

export function setPaused(st, id, paused) {
  const ev = [];
  const r = st.replicas.find(x => x.id === id);
  if (!r || r.state !== 'streaming') return ev;
  r.paused = paused;
  ev.push({ type: paused ? 'pause' : 'resume', text: paused ? `${r.id} 暂停确认，仍钉住 LSN ${r.confirmed}` : `${r.id} 恢复确认` });
  return ev;
}
