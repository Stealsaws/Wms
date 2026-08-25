// ============================================================
// Shared helpers used by every page (login, team, admin, dashboard)
// ============================================================

const CFG = window.WMS_CONFIG || {};
const CONFIG_OK =
  CFG.SUPABASE_URL &&
  !CFG.SUPABASE_URL.includes("YOUR-PROJECT-REF") &&
  CFG.SUPABASE_ANON_KEY &&
  !CFG.SUPABASE_ANON_KEY.includes("YOUR-ANON-PUBLIC-KEY");

let _sb = null;
function sb() {
  if (!_sb) {
    _sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  }
  return _sb;
}

// ---------- Session (client-side only, kept in sessionStorage) ----------
const SESSION_KEY = "wms_session_v1";

function saveSession(team, password) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ team, password }));
}
function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// role: "ADMIN" | "TEAM" (any of A/B/C) | null (any logged-in user)
function requireSession(role) {
  const s = getSession();
  if (!s) {
    location.href = "index.html";
    return null;
  }
  if (role === "ADMIN" && s.team !== "ADMIN") {
    location.href = "index.html";
    return null;
  }
  if (role === "TEAM" && !["A", "B", "C"].includes(s.team)) {
    location.href = "index.html";
    return null;
  }
  return s;
}

function teamLabel(team) {
  return { ADMIN: "ผู้ดูแลระบบ", A: "ทีม A", B: "ทีม B", C: "ทีม C" }[team] || team;
}

// ---------- Small UI helpers ----------
function money(n) {
  return Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function toast(msg, isError) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Renders the shared top bar into #topbar-slot, given the active page id.
function renderTopbar(active) {
  const slot = document.getElementById("topbar-slot");
  if (!slot) return;
  const s = getSession();
  const tabs = [];
  if (s && s.team === "ADMIN") {
    tabs.push(["admin.html", "จัดการสินค้า", "admin"]);
    tabs.push(["dashboard.html", "แดชบอร์ด", "dashboard"]);
  } else if (s) {
    tabs.push(["team.html", "สั่งซื้อสินค้า", "team"]);
    tabs.push(["dashboard.html", "แดชบอร์ด", "dashboard"]);
  }
  slot.innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="mark">WMS</span> คลังสินค้ากลาง</div>
      <div class="who">
        ${s ? `<span class="team-pill">${escapeHtml(teamLabel(s.team))}</span>
        <button class="logout-btn" id="logout-btn">ออกจากระบบ</button>` : ""}
      </div>
    </div>
    <div class="page" style="padding-bottom:0;">
      <div class="nav-tabs">
        ${tabs.map(([href, label, id]) =>
          `<a href="${href}" class="${id === active ? "active" : ""}">${label}${id === "admin" ? ` <span id="central-draw-badge" class="central-draw-badge" style="display:none;"></span>` : ""}</a>`
        ).join("")}
      </div>
    </div>
  `;
  const btn = document.getElementById("logout-btn");
  if (btn) btn.onclick = () => { clearSession(); location.href = "index.html"; };

  if (s && s.team === "ADMIN") {
    checkCentralDrawPending(false);
    setInterval(() => checkCentralDrawPending(true), 25000);
  }
}

// ---------- แจ้งเตือน "รอยืนยันการเบิกจากคลังกลาง" สำหรับ Admin ----------
let _centralDrawKnownCount = null;

async function checkCentralDrawPending(notifyOnIncrease) {
  try {
    const { count, error } = await sb()
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("central_confirmed", false)
      .neq("status", "cancelled");
    if (error) return;
    const n = count || 0;
    const badge = document.getElementById("central-draw-badge");
    if (badge) {
      if (n > 0) { badge.textContent = n; badge.style.display = "inline-flex"; }
      else { badge.style.display = "none"; }
    }
    if (notifyOnIncrease && _centralDrawKnownCount !== null && n > _centralDrawKnownCount) {
      toast(`⚡ มีรายการเบิกจากคลังกลางใหม่ ${n - _centralDrawKnownCount} รายการ รอยืนยัน`);
    }
    _centralDrawKnownCount = n;
  } catch (e) { /* เงียบไว้ ไม่รบกวนผู้ใช้ */ }
}

// Renders an order as a Thai-friendly PDF receipt and triggers a download.
// Needs jsPDF + html2canvas loaded on the page (team.html / admin.html) before this runs.
async function downloadReceiptPdf(order) {
  if (!window.jspdf || !window.html2canvas) {
    toast("ไม่พบไลบรารีสร้าง PDF กรุณารีเฟรชหน้าเว็บแล้วลองใหม่", true);
    return;
  }
  const { jsPDF } = window.jspdf;
  const items = order.order_items || [];
  const total = items.reduce((s, i) => s + i.qty * (i.unit_price || 0), 0);
  const statusText = { open: "กำลังดำเนินการ", completed: "จบการขาย", cancelled: "ยกเลิกแล้ว" }[order.status] || order.status;
  const dt = new Date(order.created_at).toLocaleString("th-TH");
  const shortId = (order.id || "").slice(0, 8);

  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:absolute;left:0;top:0;z-index:-1;width:560px;background:#fff;padding:28px;font-family:'Sarabun',sans-serif;color:#16231f;";
  wrapper.innerHTML = `
    <div style="text-align:center;margin-bottom:18px;">
      <div style="font-size:20px;font-weight:700;">คลังสินค้ากลาง</div>
      <div style="font-size:13px;color:#4c5c56;">ใบสรุปรายการสั่งซื้อ</div>
    </div>
    <table style="width:100%;font-size:12px;margin-bottom:14px;border-collapse:collapse;">
      <tr><td style="padding:2px 0;color:#4c5c56;">เลขที่บิล</td><td style="text-align:right;">${escapeHtml(shortId)}</td></tr>
      <tr><td style="padding:2px 0;color:#4c5c56;">ทีม</td><td style="text-align:right;">${escapeHtml(teamLabel(order.team))}</td></tr>
      <tr><td style="padding:2px 0;color:#4c5c56;">วันเวลา</td><td style="text-align:right;">${dt}</td></tr>
      <tr><td style="padding:2px 0;color:#4c5c56;">สถานะ</td><td style="text-align:right;">${statusText}</td></tr>
    </table>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:1.5px solid #16231f;">
          <th style="text-align:left;padding:6px 4px;">สินค้า</th>
          <th style="text-align:right;padding:6px 4px;">จำนวน</th>
          <th style="text-align:right;padding:6px 4px;">ราคา/หน่วย</th>
          <th style="text-align:right;padding:6px 4px;">รวม</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(i => `
          <tr style="border-bottom:1px solid #dcd6c4;">
            <td style="padding:6px 4px;">${escapeHtml(i.product_name)}${i.from_central_qty ? ` <span style="color:#c8792b;font-size:10px;">(เบิกกลาง ${i.from_central_qty})</span>` : ""}</td>
            <td style="text-align:right;padding:6px 4px;">${i.qty}</td>
            <td style="text-align:right;padding:6px 4px;">${money(i.unit_price || 0)}</td>
            <td style="text-align:right;padding:6px 4px;">${money(i.qty * (i.unit_price || 0))}</td>
          </tr>`).join("")}
      </tbody>
    </table>
    <div style="text-align:right;margin-top:12px;font-size:14px;font-weight:700;">
      รวมทั้งหมด: ${money(total)} บาท
    </div>
    <div style="margin-top:24px;font-size:10px;color:#4c5c56;text-align:center;">
      ออกโดยระบบคลังสินค้ากลาง · พิมพ์เมื่อ ${new Date().toLocaleString("th-TH")}
    </div>
  `;
  document.body.appendChild(wrapper);

  try {
    const canvas = await html2canvas(wrapper, { scale: 2, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    const imgWidth = pageWidth - margin * 2;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    doc.addImage(imgData, "PNG", margin, margin, imgWidth, imgHeight);
    doc.save(`ใบเสร็จ_${teamLabel(order.team)}_${shortId}.pdf`);
  } catch (e) {
    toast("สร้าง PDF ไม่สำเร็จ: " + (e.message || e), true);
  } finally {
    wrapper.remove();
  }
}

// ---------- บาร์โค้ดสแกนเนอร์ (กล้อง) สำหรับช่องค้นหา ----------
let _html5Qrcode = null;

function ensureScannerModal() {
  if (document.getElementById("scanner-modal")) return;
  const div = document.createElement("div");
  div.id = "scanner-modal";
  div.className = "modal-backdrop";
  div.style.display = "none";
  div.innerHTML = `
    <div class="modal" style="max-width:420px;">
      <h2>สแกนบาร์โค้ด</h2>
      <div id="scanner-viewport" style="width:100%;border-radius:10px;overflow:hidden;background:#000;min-height:220px;"></div>
      <p class="muted" style="margin-top:10px;">เล็งกล้องไปที่บาร์โค้ดสินค้า</p>
      <div id="scanner-msg"></div>
      <button class="btn btn-ghost btn-block" id="scanner-close-btn" style="margin-top:12px;">ปิด</button>
    </div>
  `;
  document.body.appendChild(div);
  document.getElementById("scanner-close-btn").onclick = closeScanner;
}

async function closeScanner() {
  const modal = document.getElementById("scanner-modal");
  if (modal) modal.style.display = "none";
  if (_html5Qrcode) {
    try { await _html5Qrcode.stop(); } catch (e) { /* ignore */ }
    try { await _html5Qrcode.clear(); } catch (e) { /* ignore */ }
    _html5Qrcode = null;
  }
}

async function openBarcodeScanner(onResult) {
  if (typeof Html5Qrcode === "undefined") {
    toast("ไม่พบไลบรารีสแกนบาร์โค้ด กรุณารีเฟรชหน้าเว็บแล้วลองใหม่", true);
    return;
  }
  ensureScannerModal();
  document.getElementById("scanner-msg").innerHTML = "";
  document.getElementById("scanner-modal").style.display = "flex";
  const viewport = document.getElementById("scanner-viewport");
  viewport.innerHTML = `<div id="scanner-el" style="width:100%;"></div>`;

  _html5Qrcode = new Html5Qrcode("scanner-el", {
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.QR_CODE,
    ],
    verbose: false,
  });
  try {
    await _html5Qrcode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 260, height: 140 } },
      (decodedText) => {
        onResult(decodedText);
        closeScanner();
      },
      () => { /* เฟรมที่สแกนไม่เจอ ไม่ต้องแจ้งเตือนทุกเฟรม */ }
    );
  } catch (e) {
    document.getElementById("scanner-msg").innerHTML =
      `<div class="error-msg">เปิดกล้องไม่สำเร็จ: ${escapeHtml(e.message || String(e))} (ต้องอนุญาตให้เว็บใช้กล้องก่อน)</div>`;
  }
}

// Wires a 📷 button to open the scanner and write the result into the given search input.
function wireScanButton(buttonId, inputId) {
  const btn = document.getElementById(buttonId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  btn.onclick = () => {
    openBarcodeScanner((text) => {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      toast("สแกนสำเร็จ: " + text);
    });
  };
}

// (see supabase/schema.sql) into friendly Thai messages.
function friendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (msg.includes("UNAUTHORIZED")) return "รหัสผ่านไม่ถูกต้อง";
  if (msg.startsWith("INSUFFICIENT_STOCK")) {
    const parts = msg.split(":")[1]?.split("|") || [];
    const name = parts[1] || "สินค้านี้";
    const left = parts[2] ?? "0";
    return `${name} มีไม่พอ (คงเหลือรวมคลังกลาง+ทีม ${left} ชิ้น) — กรุณาปรับจำนวนแล้วลองใหม่`;
  }
  if (msg.startsWith("INSUFFICIENT_TEAM_STOCK")) {
    const parts = msg.split(":")[1]?.split("|") || [];
    const name = parts[1] || "สินค้านี้";
    const left = parts[2] ?? "0";
    return `${name} ในทีมนี้มีไม่พอที่จะคืน (มีอยู่ ${left} ชิ้น)`;
  }
  if (msg.startsWith("INSUFFICIENT_SAMPLE_STOCK")) {
    const parts = msg.split(":")[1]?.split("|") || [];
    const name = parts[1] || "สินค้านี้";
    const left = parts[2] ?? "0";
    return `${name} มีในสต็อกตัวอย่างไม่พอ (มีอยู่ ${left} ชิ้น)`;
  }
  if (msg.includes("ALREADY_CONFIRMED")) return "รายการนี้ถูกยืนยันไปแล้ว";
  if (msg.startsWith("PRODUCT_NOT_FOUND")) return "ไม่พบสินค้านี้ในระบบ";
  if (msg.includes("EMPTY_CART")) return "ยังไม่ได้เลือกสินค้าในตะกร้า";
  if (msg.includes("INVALID_TEAM")) return "ทีมไม่ถูกต้อง";
  if (msg.includes("ALREADY_CANCELLED")) return "ออเดอร์นี้ถูกยกเลิกไปแล้ว";
  if (msg.includes("ORDER_CANCELLED")) return "ออเดอร์นี้ถูกยกเลิกไปแล้ว แก้ไขสถานะไม่ได้";
  if (msg.includes("ORDER_NOT_FOUND")) return "ไม่พบออเดอร์นี้";
  return msg;
}
