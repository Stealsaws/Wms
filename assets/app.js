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
          `<a href="${href}" class="${id === active ? "active" : ""}">${label}</a>`
        ).join("")}
      </div>
    </div>
  `;
  const btn = document.getElementById("logout-btn");
  if (btn) btn.onclick = () => { clearSession(); location.href = "index.html"; };
}

// Parses the specific error strings raised by our Postgres functions
// (see supabase/schema.sql) into friendly Thai messages.
function friendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (msg.includes("UNAUTHORIZED")) return "รหัสผ่านไม่ถูกต้อง";
  if (msg.startsWith("INSUFFICIENT_STOCK")) {
    const parts = msg.split(":")[1]?.split("|") || [];
    const name = parts[1] || "สินค้านี้";
    const left = parts[2] ?? "0";
    return `${name} มีไม่พอ (คงเหลือ ${left} ชิ้น) — กรุณาปรับจำนวนแล้วลองใหม่`;
  }
  if (msg.startsWith("PRODUCT_NOT_FOUND")) return "ไม่พบสินค้านี้ในระบบ";
  if (msg.includes("EMPTY_CART")) return "ยังไม่ได้เลือกสินค้าในตะกร้า";
  if (msg.includes("INVALID_TEAM")) return "ทีมไม่ถูกต้อง";
  if (msg.includes("ALREADY_CANCELLED")) return "ออเดอร์นี้ถูกยกเลิกไปแล้ว";
  if (msg.includes("ORDER_CANCELLED")) return "ออเดอร์นี้ถูกยกเลิกไปแล้ว แก้ไขสถานะไม่ได้";
  if (msg.includes("ORDER_NOT_FOUND")) return "ไม่พบออเดอร์นี้";
  return msg;
}
