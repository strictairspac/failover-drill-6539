// 日志空间沙盘引擎单测：node frontend/tests/logsim.test.mjs
import assert from 'node:assert/strict';
import * as sim from '../src/utils/logsim.js';
import {loglabPage,__test as page} from '../src/pages/loglab.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', n, '-', name); };

// 确定性随机源
const lcg = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const mk = (cfg = {}) => sim.createState({
  capacity: 400,
  rebuildTicks: 4,
  replicas: [
    { id: 'R1', key: true,  rate: 1000 },
    { id: 'R2', key: false, rate: 1000 },
    { id: 'R3', key: false, rate: 1000 },
  ],
  ...cfg,
});

ok('追加占用空间，重试已落盘写入不新增日志也不多占空间', () => {
  const st = mk();
  assert.equal(sim.submitWrite(st, 'w1', 100).status, 'appended');
  assert.equal(sim.usedBytes(st), 100);
  const again = sim.submitWrite(st, 'w1', 100);
  assert.equal(again.status, 'duplicate');
  assert.equal(st.entries.length, 1);
  assert.equal(sim.usedBytes(st), 100);
  assert.equal(st.stats.dupHits, 1);
});

ok('空间写满后写入排队，并给出被谁钉住的原因', () => {
  const st = mk();
  sim.setPaused(st, 'R2', true);            // 普通副本停摆，钉住基线
  sim.submitWrite(st, 'a', 150);
  sim.submitWrite(st, 'b', 150);
  sim.submitWrite(st, 'c', 150);            // 450 > 400，排队
  assert.equal(st.pending.length, 1);
  const reason = sim.waitReason(st, st.pending[0].size);
  assert.match(reason, /R2/);
  assert.match(reason, /全量重建/);
});

ok('普通副本转全量重建：旧位点释放、等待写入落盘、重建完成前不可参选', () => {
  const st = mk();
  sim.setPaused(st, 'R2', true);
  sim.submitWrite(st, 'a', 150);
  sim.submitWrite(st, 'b', 150);
  sim.submitWrite(st, 'c', 150);
  assert.equal(st.pending.length, 1);
  sim.step(st, lcg(1));                     // R1/R3 追平，基线只被停摆的 R2 钉住
  const r = sim.convertToRebuild(st, 'R2');
  assert.equal(r.ok, true);
  assert.equal(st.pending.length, 0);       // 腾出空间后等待写入落盘
  assert.ok(sim.usedBytes(st) <= st.capacity);
  const R2 = st.replicas.find(x => x.id === 'R2');
  assert.equal(sim.isCandidate(R2), false); // 重建完成前不可参选
  const snap = R2.snapshotLsn;
  for (let i = 0; i < 4; i++) sim.step(st, lcg(7));
  assert.equal(R2.state, 'streaming');
  assert.equal(sim.isCandidate(R2), true);  // 完成后恢复参选
  assert.equal(R2.confirmed, snap);         // 从快照点续追
  sim.step(st, lcg(9));
  assert.equal(R2.confirmed, st.head);      // 高速副本下一拍追平
});

ok('重点副本不能转全量重建，只能等它确认', () => {
  const st = mk();
  sim.setPaused(st, 'R1', true);
  sim.submitWrite(st, 'a', 150);
  sim.submitWrite(st, 'b', 150);
  sim.submitWrite(st, 'c', 150);
  assert.equal(st.pending.length, 1);
  sim.step(st, lcg(2));                     // R2/R3 追平，基线只被重点副本 R1 钉住
  assert.equal(sim.convertToRebuild(st, 'R1').ok, false);
  assert.match(sim.waitReason(st, st.pending[0].size), /重点副本未确认的日志必须保留/);
  sim.setPaused(st, 'R1', false);
  sim.step(st, lcg(3));
  assert.equal(st.pending.length, 0);       // 确认推进后空间释放、等待结束
});

ok('追赶确认与追加并发：同一拍内追加不阻塞副本确认', () => {
  const st = mk({ replicas: [{ id: 'R1', key: true, rate: 60 }, { id: 'R2', key: false, rate: 60 }, { id: 'R3', key: false, rate: 60 }] });
  sim.submitWrite(st, 'a', 50);
  const before = st.replicas[0].confirmed;
  sim.step(st, () => 1);
  assert.ok(st.replicas[0].confirmed > before);
});

ok('中断后恢复原状态：序列化恢复，重试仍命中去重表', () => {
  const st = mk();
  sim.submitWrite(st, 'w1', 120);
  sim.submitWrite(st, 'w2', 130);
  const restored = JSON.parse(JSON.stringify(st));
  assert.equal(restored.head, st.head);
  assert.equal(sim.usedBytes(restored), sim.usedBytes(st));
  assert.equal(sim.submitWrite(restored, 'w1', 120).status, 'duplicate');
  assert.equal(sim.usedBytes(restored), sim.usedBytes(st));
});

ok('超过日志总容量的单笔写入直接拒绝', () => {
  const st = mk();
  assert.equal(sim.submitWrite(st, 'big', 999).status, 'rejected');
  assert.equal(st.entries.length, 0);
});

ok('重建期间快照点之后的日志必须保留', () => {
  const st = mk();
  sim.setPaused(st, 'R2', true);
  sim.submitWrite(st, 'a', 150);
  sim.submitWrite(st, 'b', 150);
  sim.convertToRebuild(st, 'R2');
  const R2 = st.replicas.find(x => x.id === 'R2');
  sim.submitWrite(st, 'c', 100);
  sim.step(st, lcg(5));                     // 重建未完成
  assert.equal(R2.state, 'rebuilding');
  assert.ok(sim.floorLsn(st) <= R2.snapshotLsn); // 快照点及之后仍在保留窗口内
});

ok('随机压力下的不变量：用量不超上限、基线不越过任何钉住者、追赶位点不低于基线', () => {
  const st = sim.createState({ capacity: 1500, rebuildTicks: 5 });
  const rnd = lcg(42);
  const ids = [];
  for (let t = 0; t < 400; t++) {
    const roll = rnd();
    if (roll < 0.55) {
      const id = 'w' + t; ids.push(id);
      sim.submitWrite(st, id, 20 + Math.floor(rnd() * 200));
    } else if (roll < 0.65 && ids.length) {
      sim.submitWrite(st, ids[Math.floor(rnd() * ids.length)], 100); // 重试旧请求
    } else if (roll < 0.75) {
      const r = st.replicas[Math.floor(rnd() * 3)];
      sim.setPaused(st, r.id, rnd() < 0.5);
    } else if (roll < 0.82) {
      sim.convertToRebuild(st, rnd() < 0.5 ? 'R2' : 'R3');
    }
    sim.step(st, rnd);
    assert.ok(sim.usedBytes(st) <= st.capacity, 'used <= capacity');
    assert.ok(sim.floorLsn(st) <= sim.floorTarget(st), 'floor <= target');
    for (const r of st.replicas)
      if (r.state === 'streaming') assert.ok(r.confirmed >= sim.floorLsn(st), 'confirmed >= floor');
    for (const w of st.pending) assert.ok(w.size <= st.capacity);
  }
});

ok('页面可渲染（Node 环境下无 DOM 也能产出 HTML）', () => {
  const html = loglabPage();
  assert.match(html, /主库复制日志/);
  assert.match(html, /sim-dynamic/);
});

ok('页面级剧本：停摆→等待→重建→恢复参选，全程 HTML 可见', () => {
  const st = page.state();
  sim.setPaused(st, 'R2', true);
  for (let i = 0; i < 10; i++) page.writeOnce();
  page.tickOnce(); page.tickOnce();          // R1/R3 追平，R2 停摆钉住基线
  for (let i = 0; i < 40; i++) page.writeOnce();
  assert.ok(st.pending.length > 0, '应有写入排队');
  const waiting = loglabPage();
  assert.match(waiting, /⏳/);               // 等待队列可见
  assert.match(waiting, /钉在 LSN/);          // 等待原因可见
  sim.convertToRebuild(st, 'R2');
  assert.match(loglabPage(), /不可参选/);     // 重建期间不可参选
  for (let i = 0; i < 14; i++) page.tickOnce();
  assert.ok(st.replicas.every(r => sim.isCandidate(r)), '重建完成后全员可参选');
  const done = loglabPage();
  assert.match(done, /全量重建完成/);
  assert.match(done, /可接着追/);             // 谁还能接着追
});

console.log(`\n${n} 项检查全部通过`);
