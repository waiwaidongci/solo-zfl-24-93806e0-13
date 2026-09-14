// 状态一致性回归：
// 1) 解除申请待复核期间禁止新建调运
// 2) 旧已验收单在后续新单存在时不能退回；任何时刻每只鸽只有一张真实在途单
// 3) 落盘失败返回 500，内存同步回滚（后续查询与重启都看不到未落盘数据）
import { spawn } from "node:child_process";
import { rm, mkdir, readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { createServer } from "node:net";

const freePort = () => new Promise(resolve => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let DATA_DIR = "/tmp/pigeon-consistency-data";
let DB = `${DATA_DIR}/pigeons.json`;

let server, log = "";
async function startServer(dataDir, wipe = true, env = {}) {
  if (server) await stopServer();
  if (dataDir) DATA_DIR = dataDir;
  DB = `${DATA_DIR}/pigeons.json`;
  if (wipe) { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); }
  server = spawn(process.execPath, ["server.js"], {
    cwd: "/workspace",
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ENABLE_FAULTS: "1", ...env },
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
async function req(method, path, user, body, headers = {}) {
  return fetch(BASE + path, {
    method,
    headers: { "X-User-Id": user || "admin", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}
const J = r => r.json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cert = { healthCertNo: "HC-X", quarantineUntil: "2026-12-31" };
let passed = 0, failures = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failures++; console.log("  ✗ " + name + "\n    " + (e.message || e).toString().split("\n").join("\n    ")); }
}
const pigeonOf = async ring => (await J(await req("GET", "/api/pigeons", "admin"))).find(p => p.ringNo === ring);
const shipment = async id => (await J(await req("GET", "/api/shipments", "admin"))).find(s => s.id === id);

/* ---------- 场景 1：待复核期间禁止发单 ---------- */
async function scenario1() {
  console.log("一、解除申请待复核期间继续禁止调运");
  // 制造观察：用 008 直接登记确诊（指标鸽），007 同批 B2026-04 进观察
  await req("POST", "/api/disease-events", "admin", { ringNo: "CHN-2026-008", disease: "毛滴虫", batch: "B2026-04" });
  const obs = (await J(await req("GET", "/api/observations", "admin"))).find(o => o.ringNo === "CHN-2026-007");
  assert.ok(obs, "007 应已进观察");

  await check("观察中新建调运被拒 (423)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-007", fromLoftId: "north", toLoftId: "south", ...cert });
    assert.equal(r.status, 423);
  });
  await check("申请解除后状态=待复核", async () => {
    const r = await req("POST", `/api/observations/${obs.id}/request-release`, "north", { comment: "核酸阴性" });
    assert.equal(r.status, 200);
    assert.equal((await J(r)).status, "release_requested");
    const p = await pigeonOf("CHN-2026-007");
    assert.equal(p.underObservation, true, "待复核在查询口径仍算观察中");
  });
  await check("待复核期间新建调运仍被拒 (423)", async () => {
    const r = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-007", fromLoftId: "north", toLoftId: "south", ...cert });
    assert.equal(r.status, 423);
    assert.equal((await J(r)).error, "pigeon_under_observation");
  });
  await check("管理员驳回后依旧禁止调运", async () => {
    const r = await req("POST", `/api/observations/${obs.id}/review`, "admin", { decision: "reject", comment: "再观察" });
    assert.equal(r.status, 200);
    const r2 = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-007", fromLoftId: "north", toLoftId: "south", ...cert });
    assert.equal(r2.status, 423);
  });
  await check("复核通过后可正常发单并验收（主流程不受影响）", async () => {
    await req("POST", `/api/observations/${obs.id}/request-release`, "north", { comment: "复检阴性" });
    const rv = await req("POST", `/api/observations/${obs.id}/review`, "admin", { decision: "approve", comment: "准予解除" });
    assert.equal(rv.status, 200);
    const cr = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-007", fromLoftId: "north", toLoftId: "south", ...cert });
    assert.equal(cr.status, 201);
    const s = await J(cr);
    const ar = await req("POST", `/api/shipments/${s.id}/accept`, "south", { version: s.version });
    assert.equal(ar.status, 200);
    const p = await pigeonOf("CHN-2026-007");
    assert.equal(p.loftId, "south");
  });
}

/* ---------- 场景 2：旧单不能破坏后续状态 ---------- */
async function scenario2() {
  console.log("二、旧已验收单退回不能覆盖后续在途；每鸽一张真实在途单");
  // 单 A：north → south，验收落地
  const ca = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-001", fromLoftId: "north", toLoftId: "south", ...cert });
  const A = await J(ca);
  await req("POST", `/api/shipments/${A.id}/accept`, "south", { version: A.version });
  assert.equal((await pigeonOf("CHN-2026-001")).loftId, "south");

  // 单 B：south → breed（后续新单，处于待验收，鸽只在途）
  const cb = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-001", fromLoftId: "south", toLoftId: "breed", healthCertNo: "HC-B", quarantineUntil: "2026-12-31" });
  assert.equal(cb.status, 201);
  const B = await J(cb);

  await check("全库任意时刻每鸽至多一张进行中(pending/frozen)调运单", async () => {
    const all = await J(await req("GET", "/api/shipments", "admin"));
    const active = all.filter(s => ["pending", "frozen"].includes(s.status));
    const byRing = {};
    for (const s of active) byRing[s.ringNo] = (byRing[s.ringNo] || 0) + 1;
    assert.deepEqual(Object.values(byRing).filter(n => n > 1), []);
  });
  await check("在途期间鸽只 inTransitShipmentId 精确指向唯一在途单 B", async () => {
    const p = await pigeonOf("CHN-2026-001");
    assert.equal(p.loftId, null);
    assert.equal(p.inTransitShipmentId, B.id);
  });
  await check("旧单 A 在后续在途单 B 存在时退回被拒 (409)", async () => {
    const a = await shipment(A.id);
    const r = await req("POST", `/api/shipments/${A.id}/return`, "south", { version: a.version, reason: "事后发现问题" });
    assert.equal(r.status, 409);
    assert.equal((await J(r)).error, "newer_shipment_active");
  });
  await check("被拒后鸽只仍在途指向 B，归属未被覆盖", async () => {
    const p = await pigeonOf("CHN-2026-001");
    assert.equal(p.loftId, null);
    assert.equal(p.inTransitShipmentId, B.id);
    const a = await shipment(A.id);
    assert.equal(a.status, "accepted", "旧单状态保持已验收");
  });
  await check("目标棚错乱：breed 之外的棚不能动 B（拒收越权 403）", async () => {
    const r = await req("POST", `/api/shipments/${B.id}/reject`, "north", { version: B.version, reason: "x" });
    assert.equal(r.status, 403);
  });
  await check("B 正常拒收：鸽只回到来源棚 south，在途标记清空", async () => {
    const r = await req("POST", `/api/shipments/${B.id}/reject`, "breed", { version: B.version, reason: "状态不符" });
    assert.equal(r.status, 200);
    const p = await pigeonOf("CHN-2026-001");
    assert.equal(p.loftId, "south");
    assert.equal(p.owner, "南湾棚");
    assert.equal(p.inTransitShipmentId, null);
  });
  await check("B 关闭后旧单 A 仍不能退回：鸽只现属 south 但 A 的目标棚语义已过期（鸽只不在 A 的后续链之外被旧单改写）", async () => {
    // 此时鸽只在 south（A 目标棚），但业务上 A 已被 B 接续——再次发一张 south→north 在途单验证旧单拦截优先
    const cc = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2026-001", fromLoftId: "south", toLoftId: "north", healthCertNo: "HC-C", quarantineUntil: "2026-12-31" });
    assert.equal(cc.status, 201);
    const a = await shipment(A.id);
    const r = await req("POST", `/api/shipments/${A.id}/return`, "south", { version: a.version, reason: "x" });
    assert.equal(r.status, 409);
  });
  await check("正常拒收/验收主流程仍工作：新单 C 由 north 验收", async () => {
    const all = await J(await req("GET", "/api/shipments", "admin"));
    const C = all.filter(s => s.ringNo === "CHN-2026-001").slice(-1)[0];
    const r = await req("POST", `/api/shipments/${C.id}/accept`, "north", { version: C.version });
    assert.equal(r.status, 200);
    assert.equal((await pigeonOf("CHN-2026-001")).loftId, "north");
  });
}

/* ---------- 场景 3：落盘失败内存回滚 ---------- */
async function scenario3() {
  console.log("三、落盘失败：返回 500，内存回滚，查询与重启都看不到未落盘数据");
  // 在已运行进程上启用“下一次落盘失败”注入，再发起一张调运
  await check("落盘失败时返回 500", async () => {
    // 通过测试专用接口注入：直接设置环境变量（见下方 _fault 路由）；若无路由则用重启注入
    const r = await req("POST", "/api/_fault/fail-next-write", "admin");
    assert.equal(r.status, 204, "故障注入接口应存在");
    const cr = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2022-188", fromLoftId: "breed", toLoftId: "south", ...cert });
    assert.equal(cr.status, 500);
    const body = await J(cr);
    assert.equal(body.error, "write_failed");
  });
  await check("回滚后：内存中查不到该调运单，鸽只仍在育种棚且无在途标记", async () => {
    const ships = await J(await req("GET", "/api/shipments", "admin"));
    assert.ok(!ships.some(s => s.ringNo === "CHN-2022-188"), "未落盘调运单不得出现在内存查询");
    const p = await pigeonOf("CHN-2022-188");
    assert.equal(p.loftId, "breed");
    assert.equal(p.owner, "育种棚");
    assert.ok(p.inTransitShipmentId === null || p.inTransitShipmentId === undefined);
  });
  await check("回滚后可立即对同一只鸽正常发单（内存锁与状态可用）", async () => {
    const cr = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2022-188", fromLoftId: "breed", toLoftId: "south", healthCertNo: "HC-OK", quarantineUntil: "2026-12-31" });
    assert.equal(cr.status, 201, "回滚后应能重新发单");
  });
  await check("磁盘文件不含失败单据且为合法 JSON", async () => {
    const raw = JSON.parse(await readFile(DB, "utf8"));
    assert.ok(!raw.shipments.some(s => s.healthCertNo === "HC-X" && s.ringNo === "CHN-2022-188"));
  });
  await check("重启后仍看不到失败单据，且刚成功的单持久存在", async () => {
    await stopServer();
    await sleep(300);
    await startServer(null, false);
    const ships = await J(await req("GET", "/api/shipments", "admin"));
    assert.ok(!ships.some(s => s.ringNo === "CHN-2022-188" && s.healthCertNo === "HC-X"));
    const ok = ships.find(s => s.ringNo === "CHN-2022-188" && s.healthCertNo === "HC-OK");
    assert.ok(ok, "成功单据应在重启后仍存在");
    assert.equal(ok.status, "pending");
    // 重启后仍可正常验收
    const ar = await req("POST", `/api/shipments/${ok.id}/accept`, "south", { version: ok.version });
    assert.equal(ar.status, 200);
  });
}

/* ---------- 场景 4：并发交叉（旧单退回 vs 新单发起） ---------- */
async function scenario4() {
  console.log("四、并发：旧单退回与后续新单发起争抢，不产生双在途/归属错乱");
  // A 单 north→south 已验收
  const ca = await req("POST", "/api/shipments", "admin", { ringNo: "CHN-2023-512", fromLoftId: "breed", toLoftId: "north", healthCertNo: "HA", quarantineUntil: "2026-12-31" });
  const A = await J(ca);
  await req("POST", `/api/shipments/${A.id}/accept`, "north", { version: A.version });

  await check("并发：旧单 A 退回 与 新单 B(breed) 发起 同时进行，结果自洽", async () => {
    const a = await shipment(A.id);
    const [rRet, rNew] = await Promise.all([
      req("POST", `/api/shipments/${A.id}/return`, "north", { version: a.version, reason: "并发退回" }),
      // 新单：鸽只此时在 north → south
      req("POST", "/api/shipments", "admin", { ringNo: "CHN-2023-512", fromLoftId: "north", toLoftId: "south", healthCertNo: "HB", quarantineUntil: "2026-12-31" })
    ]);
    // 两种合法串行结果之一：
    //  先退回成功(200,鸽回breed) -> 新单因鸽不在 north 失败(422)
    //  先新单成功(201,鸽在途指向B) -> 旧单退回被 newer_shipment_active 挡下(409)
    const pair = [rRet.status, rNew.status].sort((x, y) => x - y).join(",");
    assert.ok(pair === "200,422" || pair === "201,409", "期望 200+422 或 201+409，实际 " + pair);

    const p = await pigeonOf("CHN-2023-512");
    const active = (await J(await req("GET", "/api/shipments", "admin")))
      .filter(s => s.ringNo === "CHN-2023-512" && ["pending", "frozen"].includes(s.status));
    assert.ok(active.length <= 1, "进行中单至多一张");
    if (active.length === 1) {
      assert.equal(p.loftId, null, "有在途单时鸽只必须在途");
      assert.equal(p.inTransitShipmentId, active[0].id, "在途指向必须一致");
    } else {
      assert.ok(p.loftId !== null && !p.inTransitShipmentId, "无在途单时鸽只必须落地且无在途标记");
    }
  });
}

const scenarios = [
  ["/tmp/pc-s1-observation", scenario1],
  ["/tmp/pc-s2-oldreturn", scenario2],
  ["/tmp/pc-s3-writefail", scenario3],
  ["/tmp/pc-s4-concurrency", scenario4]
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
  console.log(`\n${failures === 0 ? "一致性回归全部通过" : failures + " 项失败"}：${passed} passed`);
  process.exit(failures ? 1 : 0);
})();
