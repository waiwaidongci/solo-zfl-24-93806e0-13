// 观察期归属冻结回归：
// 观察中 / 解除待复核期间，验收、拒收、退回一律被拒且单据与鸽只状态不变；
// 只有管理员复核解除后才能继续流转。覆盖并发退回，并验证正常调运/冻结/解除不受影响。
import { spawn } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { createServer } from "node:net";

const freePort = () => new Promise(resolve => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let DATA_DIR = "/tmp/pc-obs";

let server, log = "";
async function startServer(dataDir, wipe = true) {
  if (server) await stopServer();
  if (dataDir) DATA_DIR = dataDir;
  if (wipe) { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); }
  server = spawn(process.execPath, ["server.js"], {
    cwd: "/workspace",
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", d => { log += d; });
  server.stderr.on("data", d => { log += d; });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/meta")).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server did not start:\n" + log);
}
function stopServer() {
  return new Promise(res => {
    if (!server || server.exitCode !== null) return res();
    const t = setTimeout(() => { try { server.kill("SIGKILL"); } catch {} res(); }, 3000);
    server.on("exit", () => { clearTimeout(t); res(); });
    server.kill("SIGTERM");
  });
}
async function req(method, path, user, body) {
  return fetch(BASE + path, {
    method,
    headers: { "X-User-Id": user || "admin", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}
const J = r => r.json();
let passed = 0, failures = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failures++; console.log("  ✗ " + name + "\n    " + (e.message || e).toString().split("\n").join("\n    ")); }
}
const CERT = { healthCertNo: "HC", quarantineUntil: "2026-12-31" };
const pigeonOf = async ring => (await J(await req("GET", "/api/pigeons", "admin"))).find(p => p.ringNo === ring);
const shipmentOf = async id => (await J(await req("GET", "/api/shipments", "admin"))).find(s => s.id === id);
const obsOf = async ring => (await J(await req("GET", "/api/observations", "admin"))).find(o => o.ringNo === ring && o.status !== "released");

async function makeAccepted(ring, from, to) {
  const cr = await req("POST", "/api/shipments", "admin", { ringNo: ring, fromLoftId: from, toLoftId: to, ...CERT });
  assert.equal(cr.status, 201);
  const s = await J(cr);
  const ar = await req("POST", `/api/shipments/${s.id}/accept`, to, { version: s.version });
  assert.equal(ar.status, 200);
  return s.id;
}
async function makePending(ring, from, to, certNo) {
  const cr = await req("POST", "/api/shipments", "admin", { ringNo: ring, fromLoftId: from, toLoftId: to, healthCertNo: certNo || "HC", quarantineUntil: "2026-12-31" });
  assert.equal(cr.status, 201);
  return J(cr);
}
async function disease(ring, batch, contacts = []) {
  const r = await req("POST", "/api/disease-events", "admin", { ringNo: ring, disease: "测试疫病", batch, contactRingNos: contacts });
  assert.equal(r.status, 201);
}

/* ---------- 场景一：观察中，三种流转全部拒绝且状态不变 ---------- */
async function scenarioObserving() {
  console.log("一、观察中：验收/拒收/退回全部拒绝，单据与鸽只不变");
  // 007：一张已验收单 north→south（落脚 south），无后续在途单 —— 用来验证“已验收单退回”
  const acceptedId = await makeAccepted("CHN-2026-007", "north", "south");
  // 008：一张在途单 north→south —— 确诊时被冻结，用来验证“冻结单验收/拒收”
  const pending = await makePending("CHN-2026-008", "north", "south", "HC-P");
  // 以 001 为指标、批次 B2026-04 登记确诊：007 同批次、008 同棚在途，均自动观察
  await disease("CHN-2026-001", "B2026-04");
  const frozen = await shipmentOf(pending.id);
  assert.equal(frozen.status, "frozen", "008 的在途单应被冻结");

  await check("观察中退回已验收单被拒 (423)", async () => {
    const before = await shipmentOf(acceptedId);
    const r = await req("POST", `/api/shipments/${acceptedId}/return`, "south", { version: before.version, reason: "观察期试图退回" });
    assert.equal(r.status, 423);
    assert.equal((await J(r)).error, "pigeon_under_observation");
    const after = await shipmentOf(acceptedId);
    assert.equal(after.status, "accepted", "单据仍为已验收");
    assert.equal(after.version, before.version, "版本号不变");
    assert.equal(after.events.length, before.events.length, "不得追加事件");
    const p = await pigeonOf("CHN-2026-007");
    assert.equal(p.loftId, "south", "鸽只仍在南湾棚，归属未变");
  });
  await check("观察中验收冻结在途单被拒，鸽只仍在途指向原单", async () => {
    const r = await req("POST", `/api/shipments/${pending.id}/accept`, "south", { version: frozen.version });
    assert.ok(r.status === 422 || r.status === 423, "应被拒绝，实际 " + r.status);
    const p = await pigeonOf("CHN-2026-008");
    assert.equal(p.loftId, null);
    assert.equal(p.inTransitShipmentId, pending.id, "在途指向不变");
    const s = await shipmentOf(pending.id);
    assert.equal(s.status, "frozen");
  });
  await check("观察中拒收冻结在途单被拒，鸽只仍在途指向原单", async () => {
    const before = await shipmentOf(pending.id);
    const r = await req("POST", `/api/shipments/${pending.id}/reject`, "south", { version: before.version, reason: "x" });
    assert.ok(r.status === 422 || r.status === 423, "应被拒绝，实际 " + r.status);
    const p = await pigeonOf("CHN-2026-008");
    assert.equal(p.loftId, null);
    assert.equal(p.inTransitShipmentId, pending.id);
    const s = await shipmentOf(pending.id);
    assert.equal(s.status, "frozen", "冻结单状态不变");
    assert.equal(s.version, before.version);
  });
  await check("观察中新建调运仍被拒 (423)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-007", fromLoftId: "south", toLoftId: "north", ...CERT });
    assert.equal(r.status, 423);
  });
  await check("观察标记仍在（查询口径）", async () => {
    assert.equal((await pigeonOf("CHN-2026-007")).underObservation, true);
    assert.equal((await pigeonOf("CHN-2026-008")).underObservation, true);
  });
  await check("007 复核解除后，其已验收单可正常退回，鸽只回到来源棚", async () => {
    let o = await obsOf("CHN-2026-007");
    // 接触鸽可由所在棚（south）申请，再由管理员复核
    await req("POST", `/api/observations/${o.id}/request-release`, "south", { comment: "康复" });
    const rv = await req("POST", `/api/observations/${o.id}/review`, "admin", { decision: "approve", comment: "准予解除" });
    assert.equal(rv.status, 200);
    const before = await shipmentOf(acceptedId);
    const r = await req("POST", `/api/shipments/${acceptedId}/return`, "south", { version: before.version, reason: "解除后退回" });
    assert.equal(r.status, 200);
    const p = await pigeonOf("CHN-2026-007");
    assert.equal(p.loftId, "north", "退回后回到来源棚北岸");
    assert.equal(p.owner, "北岸棚");
  });
  await check("008 复核解除后原冻结单自动解冻，可正常验收落地", async () => {
    let o = await obsOf("CHN-2026-008");
    await req("POST", `/api/observations/${o.id}/request-release`, "admin", { comment: "阴性" });
    const rv = await req("POST", `/api/observations/${o.id}/review`, "admin", { decision: "approve", comment: "准予解除" });
    assert.equal(rv.status, 200);
    const s = await shipmentOf(pending.id);
    assert.equal(s.status, "pending", "解除观察后冻结单回到待验收");
    const r = await req("POST", `/api/shipments/${pending.id}/accept`, "south", { version: s.version });
    assert.equal(r.status, 200);
    const p = await pigeonOf("CHN-2026-008");
    assert.equal(p.loftId, "south", "验收落地南湾棚");
    assert.equal(p.inTransitShipmentId, null);
  });
}

/* ---------- 场景二：解除待复核，三种流转同样拒绝 ---------- */
async function scenarioPendingReview() {
  console.log("二、解除待复核期间：流转拒绝；驳回后仍拒绝；通过后可流转");
  // 008 只持一张已验收单 north→south（落脚 south），用于“待复核期间退回”
  const acceptedId = await makeAccepted("CHN-2026-008", "north", "south");
  // 007 持一张在途单 north→south，用于“待复核期间验收/拒收冻结单”
  const pending = await makePending("CHN-2026-007", "north", "south", "HC-P2");
  // 001 指标确诊，把 007/008 作为显式接触鸽（二者都非指标，棚经办人可申请解除）
  await disease("CHN-2026-001", "", ["CHN-2026-007", "CHN-2026-008"]);
  const f0 = await shipmentOf(pending.id);
  assert.equal(f0.status, "frozen", "007 在途单应冻结");
  const o = await obsOf("CHN-2026-008");
  // 南湾棚（008 已验收单的目标棚）为 008 申请解除 → 待复核
  const rq = await req("POST", `/api/observations/${o.id}/request-release`, "south", { comment: "两次阴性" });
  assert.equal(rq.status, 200);
  assert.equal((await J(rq)).status, "release_requested");

  await check("待复核期间退回 008 已验收单被拒 (423)，鸽只仍在南湾棚", async () => {
    const before = await shipmentOf(acceptedId);
    const r = await req("POST", `/api/shipments/${acceptedId}/return`, "south", { version: before.version, reason: "抢在复核前退回" });
    assert.equal(r.status, 423);
    assert.equal((await J(r)).error, "pigeon_under_observation");
    const after = await shipmentOf(acceptedId);
    assert.equal(after.status, "accepted");
    assert.equal(after.version, before.version);
    assert.equal(after.events.length, before.events.length);
    const p = await pigeonOf("CHN-2026-008");
    assert.equal(p.loftId, "south");
    assert.equal(p.underObservation, true, "查询口径仍为观察中");
  });
  await check("待复核期间验收/拒收 007 冻结单仍被拒，鸽只仍在途指向原单", async () => {
    const f = await shipmentOf(pending.id);
    const ra = await req("POST", `/api/shipments/${pending.id}/accept`, "south", { version: f.version });
    const rr = await req("POST", `/api/shipments/${pending.id}/reject`, "south", { version: f.version, reason: "x" });
    assert.ok(ra.status >= 400 && rr.status >= 400);
    const s = await shipmentOf(pending.id);
    assert.equal(s.status, "frozen");
    assert.equal(s.version, f.version);
    const p = await pigeonOf("CHN-2026-007");
    assert.equal(p.loftId, null);
    assert.equal(p.inTransitShipmentId, pending.id);
  });
  await check("待复核期间新建调运被拒 (423)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-008", fromLoftId: "south", toLoftId: "north", ...CERT });
    assert.equal(r.status, 423);
  });
  await check("管理员驳回解除 → 回到观察中，008 已验收单退回依旧 423", async () => {
    const rv = await req("POST", `/api/observations/${o.id}/review`, "admin", { decision: "reject", comment: "再观察一周" });
    assert.equal(rv.status, 200);
    const before = await shipmentOf(acceptedId);
    const r = await req("POST", `/api/shipments/${acceptedId}/return`, "south", { version: before.version, reason: "x" });
    assert.equal(r.status, 423);
    const p = await pigeonOf("CHN-2026-008");
    assert.equal(p.loftId, "south");
  });
  await check("重新申请并复核通过 → 008 已验收单恢复可退回", async () => {
    const o2 = await obsOf("CHN-2026-008");
    await req("POST", `/api/observations/${o2.id}/request-release`, "south", { comment: "复检阴性" });
    const rv = await req("POST", `/api/observations/${o2.id}/review`, "admin", { decision: "approve", comment: "准予解除" });
    assert.equal(rv.status, 200);
    const before = await shipmentOf(acceptedId);
    const r = await req("POST", `/api/shipments/${acceptedId}/return`, "south", { version: before.version, reason: "解除后退回" });
    assert.equal(r.status, 200);
    const p = await pigeonOf("CHN-2026-008");
    assert.equal(p.loftId, "north", "退回回到来源棚北岸");
    assert.equal(p.inTransitShipmentId, null);
  });
  await check("007 复核解除 → 冻结单解冻，可正常验收落地", async () => {
    const o3 = await obsOf("CHN-2026-007");
    await req("POST", `/api/observations/${o3.id}/request-release`, "south", { comment: "阴性" });
    const rv = await req("POST", `/api/observations/${o3.id}/review`, "admin", { decision: "approve", comment: "准予解除" });
    assert.equal(rv.status, 200);
    const f = await shipmentOf(pending.id);
    assert.equal(f.status, "pending");
    const ar = await req("POST", `/api/shipments/${pending.id}/accept`, "south", { version: f.version });
    assert.equal(ar.status, 200);
    const p = await pigeonOf("CHN-2026-007");
    assert.equal(p.loftId, "south");
    assert.equal(p.inTransitShipmentId, null);
  });
}

/* ---------- 场景三：观察期并发退回，全部失败且状态不变 ---------- */
async function scenarioConcurrent() {
  console.log("三、观察期并发退回：都被拒绝，无一次生效，归属与版本不变");
  const acceptedId = await makeAccepted("CHN-2023-512", "breed", "north");
  await disease("CHN-2023-512", "B2023-02"); // 指标鸽观察中
  const before = await shipmentOf(acceptedId);

  await check("两个退回并发：均 423，单据版本与鸽只归属不变", async () => {
    const [r1, r2] = await Promise.all([
      req("POST", `/api/shipments/${acceptedId}/return`, "north", { version: before.version, reason: "并发退回1" }),
      req("POST", `/api/shipments/${acceptedId}/return`, "north", { version: before.version, reason: "并发退回2" })
    ]);
    assert.equal(r1.status, 423, "r1 实际 " + r1.status);
    assert.equal(r2.status, 423, "r2 实际 " + r2.status);
    const after = await shipmentOf(acceptedId);
    assert.equal(after.status, "accepted");
    assert.equal(after.version, before.version, "版本号不得增长");
    assert.equal(after.events.length, before.events.length, "不得写入退回事件");
    const p = await pigeonOf("CHN-2023-512");
    assert.equal(p.loftId, "north", "鸽只仍在目标棚，未被任何一次退回改走");
  });
  await check("观察期并发：退回(423) 与 新建(423) 同时发生，均不落任何变更", async () => {
    const [rRet, rNew] = await Promise.all([
      req("POST", `/api/shipments/${acceptedId}/return`, "north", { version: before.version, reason: "x" }),
      req("POST", "/api/shipments", "admin", { ringNo: "CHN-2023-512", fromLoftId: "north", toLoftId: "south", ...CERT })
    ]);
    assert.equal(rRet.status, 423);
    assert.equal(rNew.status, 423);
    const ships = await J(await req("GET", "/api/shipments", "admin"));
    const active = ships.filter(s => s.ringNo === "CHN-2023-512" && ["pending", "frozen"].includes(s.status));
    assert.equal(active.length, 0, "不得产生在途单");
  });
  await check("解除后并发验收/退回只允许一种结局（状态机自洽）", async () => {
    const o = await obsOf("CHN-2023-512");
    await req("POST", `/api/observations/${o.id}/request-release`, "admin", { comment: "康复" });
    await req("POST", `/api/observations/${o.id}/review`, "admin", { decision: "approve", comment: "解除" });
    // 再建一张在途单 breed? 鸽只现在在 north：north→south
    const s = await makePending("CHN-2023-512", "north", "south", "HC-F");
    const [a1, a2] = await Promise.all([
      req("POST", `/api/shipments/${s.id}/accept`, "south", { version: s.version }),
      req("POST", `/api/shipments/${s.id}/accept`, "south", { version: s.version })
    ]);
    const codes = [a1.status, a2.status].sort().join(",");
    assert.ok(codes === "200,422" || codes === "200,409", "一成一败，实际 " + codes);
    const p = await pigeonOf("CHN-2023-512");
    assert.equal(p.loftId, "south");
  });
}

/* ---------- 场景四：正常调运/冻结/解除主路径回归 ---------- */
async function scenarioHappyPath() {
  console.log("四、无观察时正常发起→验收→退回，以及冻结→解除链路不受影响");
  await check("正常：发起→验收→退回全程可用", async () => {
    const id = await makeAccepted("CHN-2022-188", "breed", "north");
    let s = await shipmentOf(id);
    const rr = await req("POST", `/api/shipments/${id}/return`, "north", { version: s.version, reason: "常规退回" });
    assert.equal(rr.status, 200);
    const p = await pigeonOf("CHN-2022-188");
    assert.equal(p.loftId, "breed");
    s = await shipmentOf(id);
    assert.equal(s.status, "returned");
  });
  await check("冻结→解除：观察期挡住流转，解除并结案后恢复", async () => {
    // 188 在 breed。再造在途单后确诊冻结
    const s = await makePending("CHN-2022-188", "breed", "south", "HC-Z");
    await disease("CHN-2022-188", "B2022-01");
    let f = await shipmentOf(s.id);
    assert.equal(f.status, "frozen");
    const blocked = await req("POST", `/api/shipments/${s.id}/accept`, "south", { version: f.version });
    assert.ok(blocked.status >= 400);
    const o = await obsOf("CHN-2022-188");
    await req("POST", `/api/observations/${o.id}/request-release`, "admin", { comment: "阴性" });
    await req("POST", `/api/observations/${o.id}/review`, "admin", { decision: "approve", comment: "解除" });
    f = await shipmentOf(s.id);
    assert.equal(f.status, "pending", "解冻回待验收");
    const ok = await req("POST", `/api/shipments/${s.id}/accept`, "south", { version: f.version });
    assert.equal(ok.status, 200);
    const p = await pigeonOf("CHN-2022-188");
    assert.equal(p.loftId, "south");
  });
}

const scenarios = [
  ["/tmp/pc-obs-1", scenarioObserving],
  ["/tmp/pc-obs-2", scenarioPendingReview],
  ["/tmp/pc-obs-3", scenarioConcurrent],
  ["/tmp/pc-obs-4", scenarioHappyPath]
];
(async () => {
  try {
    for (const [dir, fn] of scenarios) {
      await startServer(dir, true);
      await fn();
    }
  } finally {
    await stopServer();
  }
  console.log(`\n${failures === 0 ? "观察期归属冻结回归全部通过" : failures + " 项失败"}：${passed} passed`);
  process.exit(failures ? 1 : 0);
})();
