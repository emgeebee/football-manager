import { initAuth, onAuthChange, getSession, signOut } from "./auth.js";
import {
  loadSeasonDoc,
  saveSeasonDoc,
  fetchSeedSeason,
  listShares,
  createShare,
  revokeShare,
  setShareAccess,
  loadSharedSeason,
  saveSharedSeason,
} from "./api.js";

const POSITIONS = ["GK", "RB", "LB", "RF", "LF"];
const OUTFIELD = ["RB", "LB", "RF", "LF"];
const SHARE_PARAM = "share";
const shareDateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** @type {any} */
let season = null;
let currentMatchId = null;
let dirty = false;
let saveTimer = null;
let appStarted = false;
/** @type {{ code: string, permission: "read" | "write" } | null} */
let sharedSession = null;
/** @type {any[] | null} */
let shareLinks = null;
let shareUpdatingKey = null;

const els = {
  authGate: document.getElementById("auth-gate"),
  authError: document.getElementById("auth-error"),
  googleBtn: document.getElementById("google-btn"),
  app: document.getElementById("app"),
  userChip: document.getElementById("user-chip"),
  userPic: document.getElementById("user-pic"),
  userName: document.getElementById("user-name"),
  btnSignOut: document.getElementById("btn-sign-out"),
  btnShare: document.getElementById("btn-share"),
  shareBanner: document.getElementById("share-banner"),
  shareBannerText: document.getElementById("share-banner-text"),
  btnLeaveShare: document.getElementById("btn-leave-share"),
  shareModal: document.getElementById("share-modal"),
  shareModalBody: document.getElementById("share-modal-body"),
  shareModalError: document.getElementById("share-modal-error"),
  shareCreate: document.getElementById("share-create"),
  teamName: document.getElementById("team-name"),
  tagline: document.getElementById("tagline"),
  matchSelect: document.getElementById("match-select"),
  matchdayBar: document.getElementById("matchday-bar"),
  btnNewMatch: document.getElementById("btn-new-match"),
  viewMatch: document.getElementById("view-match"),
  viewEdit: document.getElementById("view-edit"),
  viewTeamsheet: document.getElementById("view-teamsheet"),
  viewSeason: document.getElementById("view-season"),
  viewSetup: document.getElementById("view-setup"),
  status: document.getElementById("status"),
  toast: document.getElementById("toast"),
  modes: document.querySelectorAll(".mode"),
  scopeBtns: document.querySelectorAll(".scope-btn"),
};

/** @type {"season" | "matchday" | "setup"} */
let scope = "matchday";
/** match | edit | teamsheet — only used in matchday scope */
let matchMode = "match";
/** Skip writing hash while applying one from the URL */
let applyingHash = false;

function getQuarterMinutes() {
  const q = Number(season?.quarterMinutes);
  return Number.isFinite(q) && q > 0 ? q : 10;
}

function gameMinutes() {
  return getQuarterMinutes() * 4;
}

function needsOnboarding() {
  if (!season) return true;
  if (!season.teamName?.trim()) return true;
  if (!Array.isArray(season.players) || season.players.length < 5) return true;
  if (!season.setupComplete) return true;
  return false;
}

function showError(msg) {
  els.status.hidden = false;
  els.status.textContent = msg;
}

function clearError() {
  els.status.hidden = true;
  els.status.textContent = "";
}

function showToast(msg) {
  els.toast.hidden = false;
  els.toast.textContent = msg;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
}

function formatDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayIso() {
  return toIsoDate(new Date());
}

/** Upcoming Sunday (today if today is Sunday). */
function nextSundayIso() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const day = d.getDay(); // 0 = Sunday
  if (day !== 0) d.setDate(d.getDate() + (7 - day));
  return toIsoDate(d);
}

function isFutureMatch(match) {
  if (!match?.date) return false;
  return match.date > todayIso();
}

function resultOf(match) {
  if (isFutureMatch(match)) return null;
  const a = match.fullTime?.for ?? 0;
  const b = match.fullTime?.against ?? 0;
  if (a > b) return "W";
  if (a < b) return "L";
  return "D";
}

function scoreText(match) {
  const ft = match.fullTime || { for: 0, against: 0 };
  return `${ft.for}–${ft.against}`;
}

function slotPlayers(slot) {
  if (!slot) return [];
  if (Array.isArray(slot)) return slot.filter(Boolean);
  return [slot];
}

function formatSlot(slot, quarterMinutes) {
  const names = slotPlayers(slot);
  if (names.length === 0) return "—";
  if (names.length === 1) return names[0];
  const mins = Math.round(quarterMinutes / names.length);
  return names.map((n) => `${n} (${mins}')`).join(" / ");
}

function formatMins(n) {
  if (n == null || Number.isNaN(n)) return "0";
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

/** Minutes at a position group for one match */
function minutesByRole(match, player, qMin = getQuarterMinutes()) {
  let attack = 0;
  let defence = 0;
  let gk = 0;
  for (const q of match.quarters || []) {
    for (const pos of POSITIONS) {
      const names = slotPlayers(q[pos]);
      if (!names.includes(player)) continue;
      const share = qMin / names.length;
      if (pos === "GK") gk += share;
      else if (pos === "RF" || pos === "LF") attack += share;
      else defence += share; // RB, LB
    }
  }
  const outfield = attack + defence;
  return { attack, defence, outfield, gk, total: outfield + gk };
}

function minutesForPlayerInMatch(match, player, qMin = getQuarterMinutes()) {
  return minutesByRole(match, player, qMin).total;
}

function outfieldPeriodsFromRotation(match) {
  /** @type {Record<string, number>} */
  const map = Object.fromEntries((season.players || []).map((p) => [p, 0]));
  for (const q of match.quarters || []) {
    for (const pos of OUTFIELD) {
      const names = slotPlayers(q[pos]);
      for (const name of names) {
        if (map[name] == null) map[name] = 0;
        map[name] += 1 / names.length;
      }
    }
  }
  return map;
}

function syncStatsFromRotation(match) {
  const periods = outfieldPeriodsFromRotation(match);
  const byName = Object.fromEntries((match.stats || []).map((s) => [s.player, s]));
  match.stats = (season.players || []).map((player) => {
    const prev = byName[player] || {};
    return {
      player,
      outfieldPeriods: periods[player] ?? 0,
      goals: prev.goals || 0,
      motm: !!prev.motm,
    };
  });
}

function emptyQuarter() {
  return { GK: [], RB: [], LB: [], RF: [], LF: [] };
}

function createMatch(date = nextSundayIso()) {
  const match = {
    id: `${date}-${Math.random().toString(36).slice(2, 7)}`,
    date,
    time: "",
    opponent: "",
    venue: "",
    halfTime: { for: 0, against: 0 },
    fullTime: { for: 0, against: 0 },
    ownGoals: 0,
    oppositionManager: "",
    notes: "",
    quarters: [emptyQuarter(), emptyQuarter(), emptyQuarter(), emptyQuarter()],
    stats: [],
  };
  syncStatsFromRotation(match);
  return match;
}

function clearQuarter(match, qi) {
  match.quarters[qi] = emptyQuarter();
}

function clearAllSelections(match) {
  match.quarters = [emptyQuarter(), emptyQuarter(), emptyQuarter(), emptyQuarter()];
}

function venueLabel(venue) {
  if (venue === "home") return "Home";
  if (venue === "away") return "Away";
  return "Venue?";
}

/** Home/away names and scores for BBC-style row */
function fixtureSides(match) {
  const us = season.teamName || "Us";
  const them = match.opponent || "TBC";
  const ours = match.fullTime?.for ?? 0;
  const theirs = match.fullTime?.against ?? 0;
  if (match.venue === "away") {
    return {
      home: them,
      away: us,
      homeScore: theirs,
      awayScore: ours,
      homeIsUs: false,
      awayIsUs: true,
    };
  }
  // home or unset — show us as home
  return {
    home: us,
    away: them,
    homeScore: ours,
    awayScore: theirs,
    homeIsUs: true,
    awayIsUs: false,
  };
}

function getMatch(id) {
  return season.matches.find((m) => m.id === id);
}

function readShareCode() {
  return new URLSearchParams(window.location.search).get(SHARE_PARAM);
}

function shareUrl(code) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set(SHARE_PARAM, code);
  return url.toString();
}

function isSharedView() {
  return !!sharedSession;
}

function canEdit() {
  if (!sharedSession) return true;
  return sharedSession.permission === "write";
}

function updateShareChrome() {
  const shared = isSharedView();
  if (els.btnShare) els.btnShare.hidden = shared || !season;
  if (els.shareBanner) els.shareBanner.hidden = !shared;
  if (els.shareBannerText && shared) {
    els.shareBannerText.textContent =
      sharedSession.permission === "write"
        ? "Viewing a shared team · You can edit"
        : "Viewing a shared team · View only";
  }
  if (els.btnNewMatch) els.btnNewMatch.hidden = !canEdit();
  const editTab = document.querySelector('.mode[data-mode="edit"]');
  if (editTab) editTab.hidden = !canEdit();
  document.body.classList.toggle("read-only", !canEdit());
}

function markDirty() {
  if (!canEdit()) return;
  dirty = true;
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSeason(), 500);
}

async function saveSeason() {
  if (!season || !dirty) return;
  if (!getSession()) return;
  if (!canEdit()) {
    dirty = false;
    return;
  }
  season.quarterMinutes = getQuarterMinutes();
  try {
    if (sharedSession) await saveSharedSeason(sharedSession.code, season);
    else await saveSeasonDoc(season);
    dirty = false;
    clearError();
    showToast("Saved");
  } catch (err) {
    showError(err.message || String(err));
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMatchSelect() {
  const matches = [...season.matches].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (a.time || "").localeCompare(b.time || "");
  });
  els.matchSelect.innerHTML = matches
    .map((m) => {
      const when = m.time ? `${formatDate(m.date)} ${m.time}` : formatDate(m.date);
      const venue =
        m.venue === "home" ? "Home" : m.venue === "away" ? "Away" : "Venue?";
      const label = `${when} · ${venue} · ${m.opponent || "(no opponent)"}`;
      return `<option value="${m.id}">${escapeHtml(label)}</option>`;
    })
    .join("");
  if (!currentMatchId || !getMatch(currentMatchId)) {
    currentMatchId = matches[0]?.id ?? null;
  }
  if (currentMatchId) els.matchSelect.value = currentMatchId;
}

function renderMatchView(match) {
  const qMin = getQuarterMinutes();
  const res = resultOf(match);
  const ht = match.halfTime || { for: 0, against: 0 };

  const rotationRows = (match.quarters || [])
    .map((q, i) => {
      const cells = POSITIONS.map((pos) => {
        const html = formatSlot(q[pos], qMin)
          .split(" / ")
          .map((part) =>
            part.includes("(") ? `<span class="split">${part}</span>` : part
          )
          .join(" / ");
        return `<td>${html}</td>`;
      }).join("");
      return `<tr><th>Q${i + 1}</th>${cells}</tr>`;
    })
    .join("");

  const stats = [...(match.stats || [])].sort((a, b) =>
    a.player.localeCompare(b.player)
  );
  const statsRows = stats
    .map((s) => {
      const role = minutesByRole(match, s.player, qMin);
      return `<tr class="${s.motm ? "motm-row" : ""}">
        <td>${escapeHtml(s.player)}${s.motm ? ' <span class="motm-mark">MOTM</span>' : ""}</td>
        <td class="num">${formatMins(s.outfieldPeriods ?? 0)}</td>
        <td class="num">${formatMins(role.outfield)}</td>
        <td class="num">${formatMins(role.gk)}</td>
        <td class="num">${formatMins(role.total)}</td>
        <td class="num">${s.goals ?? 0}</td>
      </tr>`;
    })
    .join("");

  const notesBits = [];
  if (match.oppositionManager) {
    notesBits.push(
      `<p class="meta"><strong>Opposition manager:</strong> ${escapeHtml(match.oppositionManager)}</p>`
    );
  }
  if (match.notes) {
    notesBits.push(`<p class="notes">${escapeHtml(match.notes)}</p>`);
  }

  const venue = match.venue === "home" || match.venue === "away" ? match.venue : "";
  const future = isFutureMatch(match);
  const scoreBlock = future
    ? `<span class="badge D">Upcoming</span>`
    : `<span class="score">${scoreText(match)}</span>
        <span class="badge ${res}">${res === "W" ? "Win" : res === "L" ? "Loss" : "Draw"}</span>`;
  const metaExtra = future
    ? ` · ${gameMinutes()} mins`
    : ` · HT ${ht.for}–${ht.against} · ${gameMinutes()} mins${match.ownGoals ? ` · ${match.ownGoals} OG` : ""}`;
  els.viewMatch.innerHTML = `
    <div class="match-hero">
      <h1>v ${escapeHtml(match.opponent || "TBC")}</h1>
      <div class="score-row">
        ${scoreBlock}
        ${venue ? `<span class="venue-badge ${venue}">${venueLabel(venue)}</span>` : `<span class="venue-badge">Venue?</span>`}
        <span class="meta">${formatDate(match.date)}${match.time ? ` ${escapeHtml(match.time)}` : ""}${metaExtra}</span>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h2>Rotation</h2>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th></th>
                ${POSITIONS.map((p) => `<th>${p}</th>`).join("")}
              </tr>
            </thead>
            <tbody>${rotationRows}</tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>Player stats</h2>
        <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th class="num">Outfield Q</th>
                <th class="num">Outfield</th>
                <th class="num">GK</th>
                <th class="num">Total</th>
                <th class="num">Goals</th>
              </tr>
            </thead>
            <tbody>${statsRows || `<tr><td colspan="6">No stats yet</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>
    ${
      notesBits.length
        ? `<div class="panel" style="margin-top:1.25rem"><h2>Notes</h2>${notesBits.join("")}</div>`
        : ""
    }
  `;
}

function playersUsedInQuarter(quarter, exceptPos, exceptSlot) {
  const used = new Set();
  for (const pos of POSITIONS) {
    const names = slotPlayers(quarter[pos]);
    names.forEach((name, slot) => {
      if (pos === exceptPos && slot === exceptSlot) return;
      used.add(name);
    });
  }
  return used;
}

function playerOptions(quarter, pos, slotIndex, selected) {
  const used = playersUsedInQuarter(quarter, pos, slotIndex);
  const opts = [`<option value="">—</option>`];
  for (const name of season.players) {
    if (used.has(name) && name !== selected) continue;
    const sel = name === selected ? " selected" : "";
    opts.push(`<option value="${escapeHtml(name)}"${sel}>${escapeHtml(name)}</option>`);
  }
  return opts.join("");
}

function renderSlotEditors(quarter, qi, pos) {
  const names = slotPlayers(quarter[pos]);
  const split = names.length > 1;
  const primary = names[0] || "";
  const secondary = names[1] || "";

  let html = `
    <div class="slot-edit" data-qi="${qi}" data-pos="${pos}">
      <select class="player-select" data-qi="${qi}" data-pos="${pos}" data-slot="0" aria-label="Q${qi + 1} ${pos}">
        ${playerOptions(quarter, pos, 0, primary)}
      </select>`;

  if (split) {
    html += `
      <select class="player-select" data-qi="${qi}" data-pos="${pos}" data-slot="1" aria-label="Q${qi + 1} ${pos} split">
        ${playerOptions(quarter, pos, 1, secondary)}
      </select>
      <button type="button" class="btn-link" data-action="unsplit" data-qi="${qi}" data-pos="${pos}">Remove split</button>`;
  } else {
    html += `
      <button type="button" class="btn-link" data-action="split" data-qi="${qi}" data-pos="${pos}">Split 5'+5'</button>`;
  }

  html += `</div>`;
  return html;
}

function renderEditView(match) {
  syncStatsFromRotation(match);

  const rotationBlocks = (match.quarters || [])
    .map((q, qi) => {
      const cols = POSITIONS.map(
        (pos) => `
        <div class="edit-pos">
          <span class="pos-label">${pos}</span>
          ${renderSlotEditors(q, qi, pos)}
        </div>`
      ).join("");
      return `
        <div class="edit-quarter">
          <div class="edit-quarter-head">
            <h3>Q${qi + 1} <span class="muted">${getQuarterMinutes()} mins</span></h3>
            <button type="button" class="btn-link" data-action="clear-quarter" data-qi="${qi}">Clear quarter</button>
          </div>
          <div class="edit-positions">${cols}</div>
        </div>`;
    })
    .join("");

  const statsRows = (match.stats || [])
    .map((s) => {
      const role = minutesByRole(match, s.player);
      return `<tr class="${s.motm ? "motm-row" : ""}">
        <td>${escapeHtml(s.player)}</td>
        <td class="num">${formatMins(s.outfieldPeriods)}</td>
        <td class="num">${formatMins(role.outfield)}</td>
        <td class="num">${formatMins(role.gk)}</td>
        <td class="num">${formatMins(role.total)}</td>
        <td class="num">
          <input type="number" min="0" step="1" class="stat-input" data-stat="goals" data-player="${escapeHtml(s.player)}" value="${s.goals || 0}" />
        </td>
        <td class="num">
          <input type="radio" name="motm" data-stat="motm" data-player="${escapeHtml(s.player)}" ${s.motm ? "checked" : ""} />
        </td>
      </tr>`;
    })
    .join("");

  els.viewEdit.innerHTML = `
    <div class="edit-toolbar">
      <p class="edit-hint">Changes save automatically. Dropdowns hide players already used in that quarter.</p>
      <button type="button" class="btn btn-danger" id="btn-delete-match">Delete match</button>
    </div>

    <div class="panel edit-meta">
      <h2>Match details</h2>
      <div class="form-grid form-meta">
        <label>Date
          <input type="date" id="edit-date" value="${escapeHtml(match.date || "")}" />
        </label>
        <label>Kick-off
          <input type="time" id="edit-time" value="${escapeHtml(match.time || "")}" />
        </label>
        <label>Home / Away
          <select id="edit-venue">
            <option value="" ${!match.venue ? "selected" : ""}>Not set</option>
            <option value="home" ${match.venue === "home" ? "selected" : ""}>Home</option>
            <option value="away" ${match.venue === "away" ? "selected" : ""}>Away</option>
          </select>
        </label>
        <label class="span-all">Opponent
          <input type="text" id="edit-opponent" value="${escapeHtml(match.opponent || "")}" placeholder="Team name" />
        </label>
      </div>

      <div class="score-block">
        <div class="score-grid" role="group" aria-label="Scores">
          <span class="score-corner"></span>
          <span class="score-colhead">For</span>
          <span class="score-colhead">Against</span>
          <span class="score-rowhead">HT</span>
          <input type="number" min="0" id="edit-ht-for" aria-label="Half-time for" value="${match.halfTime?.for ?? 0}" />
          <input type="number" min="0" id="edit-ht-against" aria-label="Half-time against" value="${match.halfTime?.against ?? 0}" />
          <span class="score-rowhead">FT</span>
          <input type="number" min="0" id="edit-ft-for" aria-label="Full-time for" value="${match.fullTime?.for ?? 0}" />
          <input type="number" min="0" id="edit-ft-against" aria-label="Full-time against" value="${match.fullTime?.against ?? 0}" />
        </div>
        <label class="og-field">Own goals (for us)
          <input type="number" min="0" id="edit-og" value="${match.ownGoals ?? 0}" />
        </label>
      </div>

      <div class="form-grid form-notes">
        <label class="span-all">Opposition manager
          <input type="text" id="edit-opp-mgr" value="${escapeHtml(match.oppositionManager || "")}" />
        </label>
        <label class="span-all">Notes
          <textarea id="edit-notes" rows="3">${escapeHtml(match.notes || "")}</textarea>
        </label>
      </div>
    </div>

    <div class="panel" style="margin-top:1.25rem">
      <h2>Rotation <span class="muted">${gameMinutes()} mins · 4 × ${getQuarterMinutes()}</span></h2>
      <div class="rotation-actions">
        <button type="button" class="btn-link" id="btn-clear-all-positions">Clear all position selections</button>
      </div>
      <div class="edit-rotation">${rotationBlocks}</div>
    </div>

    <div class="panel" style="margin-top:1.25rem">
      <h2>Goals &amp; MOTM</h2>
      <p class="edit-hint">Outfield quarters and minutes update from the rotation. Tick one MOTM.</p>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th class="num">Outfield Q</th>
              <th class="num">Outfield</th>
              <th class="num">GK</th>
              <th class="num">Total</th>
              <th class="num">Goals</th>
              <th class="num">MOTM</th>
            </tr>
          </thead>
          <tbody>${statsRows}</tbody>
        </table>
      </div>
      <p class="edit-hint" style="margin-top:0.75rem">
        <button type="button" class="btn-link" id="btn-clear-motm">Clear MOTM</button>
      </p>
    </div>
  `;

  wireEditHandlers(match);
}

function wireEditHandlers(match) {
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", fn);
    el.addEventListener("change", fn);
  };

  bind("edit-date", (e) => {
    match.date = e.target.value;
    if (match.date && !match.id.startsWith(match.date)) {
      match.id = `${match.date}-${match.id.split("-").slice(-1)[0] || "game"}`;
      currentMatchId = match.id;
      writeHash();
    }
    renderMatchSelect();
    markDirty();
  });
  bind("edit-time", (e) => {
    match.time = e.target.value;
    renderMatchSelect();
    markDirty();
  });
  bind("edit-venue", (e) => {
    match.venue = e.target.value;
    markDirty();
  });
  bind("edit-opponent", (e) => {
    match.opponent = e.target.value;
    renderMatchSelect();
    markDirty();
  });
  bind("edit-og", (e) => {
    match.ownGoals = Math.max(0, Number(e.target.value) || 0);
    markDirty();
  });

  document.getElementById("btn-clear-all-positions")?.addEventListener("click", () => {
    if (!confirm("Clear all player selections for this match?")) return;
    clearAllSelections(match);
    syncStatsFromRotation(match);
    markDirty();
    renderEditView(match);
  });

  els.viewEdit.querySelectorAll("[data-action=clear-quarter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const qi = Number(btn.dataset.qi);
      clearQuarter(match, qi);
      syncStatsFromRotation(match);
      markDirty();
      renderEditView(match);
    });
  });
  bind("edit-ht-for", (e) => {
    match.halfTime = match.halfTime || { for: 0, against: 0 };
    match.halfTime.for = Number(e.target.value) || 0;
    markDirty();
  });
  bind("edit-ht-against", (e) => {
    match.halfTime = match.halfTime || { for: 0, against: 0 };
    match.halfTime.against = Number(e.target.value) || 0;
    markDirty();
  });
  bind("edit-ft-for", (e) => {
    match.fullTime = match.fullTime || { for: 0, against: 0 };
    match.fullTime.for = Number(e.target.value) || 0;
    markDirty();
  });
  bind("edit-ft-against", (e) => {
    match.fullTime = match.fullTime || { for: 0, against: 0 };
    match.fullTime.against = Number(e.target.value) || 0;
    markDirty();
  });
  bind("edit-opp-mgr", (e) => {
    match.oppositionManager = e.target.value;
    markDirty();
  });
  bind("edit-notes", (e) => {
    match.notes = e.target.value;
    markDirty();
  });

  document.getElementById("btn-delete-match")?.addEventListener("click", () => {
    if (!confirm(`Delete match v ${match.opponent || "TBC"} on ${formatDate(match.date)}?`)) {
      return;
    }
    season.matches = season.matches.filter((m) => m.id !== match.id);
    currentMatchId = season.matches[0]?.id ?? null;
    markDirty();
    renderMatchSelect();
    if (!currentMatchId) {
      const m = createMatch();
      season.matches.push(m);
      currentMatchId = m.id;
      renderMatchSelect();
    }
    setMatchMode("edit");
  });

  document.getElementById("btn-clear-motm")?.addEventListener("click", () => {
    for (const s of match.stats || []) s.motm = false;
    markDirty();
    renderEditView(match);
  });

  els.viewEdit.querySelectorAll(".player-select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const qi = Number(e.target.dataset.qi);
      const pos = e.target.dataset.pos;
      const slot = Number(e.target.dataset.slot);
      const value = e.target.value;
      const q = match.quarters[qi];
      let names = [...slotPlayers(q[pos])];
      while (names.length <= slot) names.push("");
      names[slot] = value;
      names = names.filter((n, i) => (i === 0 ? true : n));
      if (!names[0] && names.length > 1) names = names.filter(Boolean);
      q[pos] = names.filter(Boolean);
      syncStatsFromRotation(match);
      markDirty();
      renderEditView(match);
    });
  });

  els.viewEdit.querySelectorAll("[data-action=split]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const qi = Number(btn.dataset.qi);
      const pos = btn.dataset.pos;
      const names = slotPlayers(match.quarters[qi][pos]);
      match.quarters[qi][pos] = [names[0] || "", ""];
      markDirty();
      renderEditView(match);
    });
  });

  els.viewEdit.querySelectorAll("[data-action=unsplit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const qi = Number(btn.dataset.qi);
      const pos = btn.dataset.pos;
      const names = slotPlayers(match.quarters[qi][pos]);
      match.quarters[qi][pos] = names[0] ? [names[0]] : [];
      syncStatsFromRotation(match);
      markDirty();
      renderEditView(match);
    });
  });

  els.viewEdit.querySelectorAll('input[data-stat="goals"]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const player = e.target.dataset.player;
      const row = match.stats.find((s) => s.player === player);
      if (row) row.goals = Math.max(0, Number(e.target.value) || 0);
      markDirty();
    });
  });

  els.viewEdit.querySelectorAll('input[data-stat="motm"]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const player = e.target.dataset.player;
      for (const s of match.stats) s.motm = s.player === player;
      markDirty();
      renderEditView(match);
    });
  });
}

function posClass(pos) {
  if (pos === "GK") return "gk";
  if (pos === "RF" || pos === "LF") return "fwd";
  return "def";
}

function renderPitch(quarter, index, quarterMinutes) {
  const slots = POSITIONS.map((pos) => {
    const names = slotPlayers(quarter[pos]);
    const split = names.length > 1;
    const mins = split ? Math.round(quarterMinutes / names.length) : null;
    const label = split
      ? names
          .map(
            (n) =>
              `<span class="split-line">${escapeHtml(n)} <span class="mins">${mins}'</span></span>`
          )
          .join("")
      : `<span>${escapeHtml(names[0] || "—")}</span>`;
    const nameAbove = pos === "LF" || pos === "RF";
    return `
      <div class="slot ${pos}${nameAbove ? " name-above" : ""}">
        <div class="dot ${posClass(pos)}">${pos}</div>
        <div class="slot-name">${label}</div>
      </div>`;
  }).join("");

  return `
    <article class="quarter-card">
      <h2 class="quarter-label">Q${index + 1}</h2>
      <div class="pitch" aria-label="Quarter ${index + 1} pitch">
        <div class="pitch-lines"></div>
        <div class="box-top"></div>
        <div class="box-bottom"></div>
        ${slots}
      </div>
    </article>`;
}

function renderTeamsheet(match) {
  const pitches = (match.quarters || [])
    .map((q, i) => renderPitch(q, i, getQuarterMinutes()))
    .join("");

  const qMin = getQuarterMinutes();
  els.viewTeamsheet.innerHTML = `
    <div class="teamsheet-head">
      <h1>Quarter lineups v ${escapeHtml(match.opponent || "TBC")}</h1>
      <p>${qMin} mins per quarter · split positions: ${qMin / 2} mins each · ${gameMinutes()} mins total</p>
    </div>
    <div class="pitches">${pitches}</div>
  `;
}

function aggregateSeason() {
  /** @type {Record<string, any>} */
  const byPlayer = {};

  const blank = (name) => ({
    player: name,
    motm: 0,
    goals: 0,
    minutes: 0,
    attackMins: 0,
    defenceMins: 0,
    outfieldMins: 0,
    gkMins: 0,
    outfieldPeriods: 0,
    appearances: 0,
  });

  for (const name of season.players || []) {
    byPlayer[name] = blank(name);
  }

  for (const match of season.matches || []) {
    for (const s of match.stats || []) {
      if (!byPlayer[s.player]) byPlayer[s.player] = blank(s.player);
      const row = byPlayer[s.player];
      row.motm += s.motm ? 1 : 0;
      row.goals += s.goals || 0;
      row.outfieldPeriods += s.outfieldPeriods || 0;
    }

    for (const name of Object.keys(byPlayer)) {
      const role = minutesByRole(match, name);
      if (role.total > 0) {
        byPlayer[name].minutes += role.total;
        byPlayer[name].attackMins += role.attack;
        byPlayer[name].defenceMins += role.defence;
        byPlayer[name].outfieldMins += role.outfield;
        byPlayer[name].gkMins += role.gk;
        byPlayer[name].appearances += 1;
      }
    }
  }

  return Object.values(byPlayer).filter(
    (p) => p.appearances > 0 || p.goals > 0 || p.motm > 0
  );
}

function boardList(rows, key, suffix = "") {
  const sorted = [...rows].sort((a, b) => {
    if (b[key] !== a[key]) return b[key] - a[key];
    return a.player.localeCompare(b.player);
  });
  return sorted
    .map((r, i) => {
      const val = r[key];
      const display = typeof val === "number" ? formatMins(val) : val;
      return `<li>
        <span class="rank">${i + 1}</span>
        <span>${escapeHtml(r.player)}</span>
        <span class="stat-val">${display}${suffix}</span>
      </li>`;
    })
    .join("");
}

function renderSeason() {
  const rows = aggregateSeason();
  const n = season.matches?.length || 0;
  const chronological = [...(season.matches || [])].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.time || "").localeCompare(b.time || "");
  });

  const results = chronological
    .map((m) => {
      const sides = fixtureSides(m);
      const future = isFutureMatch(m);
      const res = resultOf(m);
      const unset = !m.venue
        ? `<div class="bbc-unset"><span class="venue-badge">Set home/away in Matchday → Edit</span></div>`
        : "";
      const koTime = m.time || "TBC";
      const scoreCentre = future
        ? `<div class="bbc-score bbc-score-fixture">
            <span class="bbc-ko">${escapeHtml(koTime)}</span>
            <div class="bbc-ft"><span class="bbc-date">${escapeHtml(formatDate(m.date))}</span></div>
          </div>`
        : `<div class="bbc-score">
            <span class="bbc-n">${sides.homeScore}</span>
            <span class="bbc-pipe" aria-hidden="true"></span>
            <span class="bbc-n">${sides.awayScore}</span>
            <div class="bbc-ft">FT<span class="bbc-date">${escapeHtml(formatDate(m.date))}${m.time ? ` · ${escapeHtml(m.time)}` : ""}</span></div>
          </div>`;
      return `
        <article class="bbc-row ${res || "fixture"}">
          <div class="bbc-home${sides.homeIsUs ? " us" : ""}">${escapeHtml(sides.home)}</div>
          ${scoreCentre}
          <div class="bbc-away${sides.awayIsUs ? " us" : ""}">${escapeHtml(sides.away)}</div>
          ${unset}
        </article>`;
    })
    .join("");

  els.viewSeason.innerHTML = `
    <div class="season-head">
      <h1>Season results</h1>
      <p>${n} match${n === 1 ? "" : "es"}</p>
    </div>
    <div class="bbc-results">${results || `<p class="season-intro">No matches yet</p>`}</div>
    <div class="panel season-table-wrap">
      <h2>Player totals</h2>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th class="num">Apps</th>
              <th class="num">Attack</th>
              <th class="num">Defence</th>
              <th class="num">GK</th>
              <th class="num">Total</th>
              <th class="num">Outfield Q</th>
              <th class="num">Goals</th>
              <th class="num">MOTM</th>
            </tr>
          </thead>
          <tbody>
            ${[...rows]
              .sort((a, b) => a.player.localeCompare(b.player))
              .map(
                (r) => `<tr>
                  <td>${escapeHtml(r.player)}</td>
                  <td class="num">${r.appearances}</td>
                  <td class="num">${formatMins(r.attackMins)}</td>
                  <td class="num">${formatMins(r.defenceMins)}</td>
                  <td class="num">${formatMins(r.gkMins)}</td>
                  <td class="num">${formatMins(r.minutes)}</td>
                  <td class="num">${formatMins(r.outfieldPeriods)}</td>
                  <td class="num">${r.goals}</td>
                  <td class="num">${r.motm}</td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renamePlayerEverywhere(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  for (const match of season.matches || []) {
    for (const q of match.quarters || []) {
      for (const pos of POSITIONS) {
        q[pos] = slotPlayers(q[pos]).map((n) => (n === oldName ? newName : n));
      }
    }
    for (const s of match.stats || []) {
      if (s.player === oldName) s.player = newName;
    }
  }
}

function removePlayerEverywhere(name) {
  season.players = season.players.filter((p) => p !== name);
  for (const match of season.matches || []) {
    for (const q of match.quarters || []) {
      for (const pos of POSITIONS) {
        q[pos] = slotPlayers(q[pos]).filter((n) => n !== name);
      }
    }
    match.stats = (match.stats || []).filter((s) => s.player !== name);
  }
}

function renderSetup() {
  const players = season.players || [];
  const editable = canEdit();
  const rows = players
    .map(
      (name, i) => `
      <li class="squad-row" data-index="${i}">
        <input type="text" class="squad-name" value="${escapeHtml(name)}" aria-label="Player ${i + 1}" ${editable ? "" : "disabled"} />
        ${
          editable
            ? `<button type="button" class="btn-link squad-remove" data-index="${i}" ${players.length <= 5 ? "disabled" : ""}>Remove</button>`
            : ""
        }
      </li>`
    )
    .join("");

  const firstTime = !season.setupComplete && !isSharedView();
  els.viewSetup.innerHTML = `
    <div class="setup-head">
      <h1>${firstTime ? "Welcome — set up your team" : "Team setup"}</h1>
      <p>${editable ? "You can change these anytime from Setup." : "View only — ask the owner for edit access."}</p>
    </div>
    <div class="panel setup-panel">
      <label class="setup-field">Team name
        <input type="text" id="setup-team-name" value="${escapeHtml(season.teamName || "")}" placeholder="e.g. Writtle Minors Red" ${editable ? "" : "disabled"} />
      </label>
      <label class="setup-field">Minutes per quarter
        <input type="number" id="setup-quarter-mins" min="1" max="30" step="1" value="${getQuarterMinutes()}" ${editable ? "" : "disabled"} />
        <span class="setup-hint">Full game = 4 × this (${gameMinutes()} mins with current setting)</span>
      </label>
      <div class="setup-squad">
        <div class="setup-squad-head">
          <h2>Squad</h2>
          ${editable ? `<button type="button" class="btn btn-secondary" id="setup-add-player">Add player</button>` : ""}
        </div>
        ${editable ? `<p class="edit-hint">At least 5 players. Renaming updates past match sheets.</p>` : ""}
        <ol class="squad-list">${rows}</ol>
      </div>
      ${
        editable
          ? `<div class="setup-actions">
        <button type="button" class="btn btn-secondary" id="setup-done">
          ${firstTime ? "Save & continue" : "Done"}
        </button>
      </div>`
          : ""
      }
    </div>
  `;

  if (editable) wireSetupHandlers();
}

function wireSetupHandlers() {
  const teamInput = document.getElementById("setup-team-name");
  const minsInput = document.getElementById("setup-quarter-mins");

  teamInput?.addEventListener("change", () => {
    season.teamName = teamInput.value.trim();
    document.title = `${season.teamName || "Matchday"} — Matchday`;
    if (els.teamName) els.teamName.textContent = season.teamName || "Matchday";
    markDirty();
  });

  minsInput?.addEventListener("change", () => {
    let q = Math.round(Number(minsInput.value) || 10);
    q = Math.min(30, Math.max(1, q));
    minsInput.value = String(q);
    season.quarterMinutes = q;
    const hint = minsInput.parentElement?.querySelector(".setup-hint");
    if (hint) hint.textContent = `Full game = 4 × this (${q * 4} mins with current setting)`;
    markDirty();
  });

  document.getElementById("setup-add-player")?.addEventListener("click", () => {
    let n = 1;
    let name = `Player ${season.players.length + 1}`;
    while (season.players.includes(name)) {
      n += 1;
      name = `Player ${season.players.length + n}`;
    }
    season.players.push(name);
    for (const match of season.matches || []) {
      if (!match.stats?.some((s) => s.player === name)) {
        match.stats = match.stats || [];
        match.stats.push({ player: name, outfieldPeriods: 0, goals: 0, motm: false });
      }
    }
    markDirty();
    renderSetup();
  });

  els.viewSetup.querySelectorAll(".squad-name").forEach((input) => {
    input.addEventListener("change", () => {
      const idx = Number(input.closest(".squad-row")?.dataset.index);
      const oldName = season.players[idx];
      const newName = input.value.trim();
      if (!newName) {
        input.value = oldName;
        showError("Player name can’t be empty");
        return;
      }
      if (season.players.some((p, i) => i !== idx && p === newName)) {
        input.value = oldName;
        showError("That name is already in the squad");
        return;
      }
      clearError();
      season.players[idx] = newName;
      renamePlayerEverywhere(oldName, newName);
      markDirty();
    });
  });

  els.viewSetup.querySelectorAll(".squad-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (season.players.length <= 5) return;
      const idx = Number(btn.dataset.index);
      const name = season.players[idx];
      if (!confirm(`Remove ${name} from the squad? They’ll be cleared from rotations.`)) return;
      removePlayerEverywhere(name);
      markDirty();
      renderSetup();
    });
  });

  document.getElementById("setup-done")?.addEventListener("click", () => {
    season.teamName = (document.getElementById("setup-team-name")?.value || "").trim();
    let q = Math.round(Number(document.getElementById("setup-quarter-mins")?.value) || 10);
    season.quarterMinutes = Math.min(30, Math.max(1, q));
    if (!season.teamName) {
      showError("Enter a team name");
      return;
    }
    if (!season.players?.length || season.players.length < 5) {
      showError("Add at least 5 players");
      return;
    }
    if (season.players.some((p) => !p.trim())) {
      showError("Every player needs a name");
      return;
    }
    clearError();
    season.setupComplete = true;
    markDirty();
    setScope("matchday");
    setMatchMode("match");
  });
}

function hashForState() {
  if (scope === "setup") return "#/setup";
  if (scope === "season") return "#/season";
  const id = currentMatchId ? encodeURIComponent(currentMatchId) : "";
  return `#/matchday/${matchMode}/${id}`;
}

function writeHash() {
  if (applyingHash) return;
  const next = hashForState();
  if (location.hash !== next) location.hash = next;
}

function parseHash() {
  const raw = (location.hash || "").replace(/^#\/?/, "").trim();
  if (!raw) return { scope: null };
  const parts = raw.split("/").map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (parts[0] === "setup") return { scope: "setup" };
  if (parts[0] === "season") return { scope: "season" };
  if (parts[0] === "matchday") {
    const mode = ["match", "edit", "teamsheet"].includes(parts[1]) ? parts[1] : "match";
    return { scope: "matchday", matchMode: mode, matchId: parts[2] || null };
  }
  if (["match", "edit", "teamsheet"].includes(parts[0])) {
    return { scope: "matchday", matchMode: parts[0], matchId: parts[1] || null };
  }
  return { scope: "matchday", matchMode: "match", matchId: null };
}

function applyHash() {
  if (!season) return;
  applyingHash = true;
  try {
    const h = parseHash();
    if (h.matchId && getMatch(h.matchId)) {
      currentMatchId = h.matchId;
    }
    if (h.scope === "setup") {
      setScope("setup", { skipHash: true });
    } else if (h.scope === "season") {
      setScope("season", { skipHash: true });
    } else if (h.scope === "matchday" || h.matchMode) {
      setScope("matchday", { skipHash: true });
      setMatchMode(h.matchMode || "match", { skipHash: true });
    } else {
      setScope("matchday", { skipHash: true });
      setMatchMode("match", { skipHash: true });
    }
    if (els.matchSelect && currentMatchId) {
      els.matchSelect.value = currentMatchId;
    }
  } finally {
    applyingHash = false;
  }
}

function setScope(next, { skipHash = false } = {}) {
  scope = next;
  els.scopeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.scope === scope);
  });
  if (els.matchdayBar) els.matchdayBar.hidden = scope !== "matchday";
  if (els.tagline) {
    els.tagline.textContent =
      scope === "season"
        ? "Season overview"
        : scope === "setup"
          ? "Team setup"
          : "Matchday sheet";
  }
  applyViewVisibility();
  render();
  if (!skipHash) writeHash();
}

function setMatchMode(next, { skipHash = false } = {}) {
  if (next === "edit" && !canEdit()) next = "match";
  matchMode = next;
  els.modes.forEach((btn) => {
    const on = btn.dataset.mode === matchMode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  applyViewVisibility();
  render();
  if (!skipHash) writeHash();
}

function applyViewVisibility() {
  const onSetup = scope === "setup";
  const onSeason = scope === "season";
  if (els.viewSetup) els.viewSetup.hidden = !onSetup;
  els.viewSeason.hidden = !onSeason;
  els.viewMatch.hidden = onSetup || onSeason || matchMode !== "match";
  els.viewEdit.hidden = onSetup || onSeason || matchMode !== "edit";
  els.viewTeamsheet.hidden = onSetup || onSeason || matchMode !== "teamsheet";
}

function render() {
  if (!season) return;
  season.quarterMinutes = getQuarterMinutes();
  updateShareChrome();
  if (els.teamName) els.teamName.textContent = season.teamName || "Matchday";
  document.title = `${season.teamName || "Matchday"} — Matchday`;
  if (scope === "setup") {
    renderSetup();
    return;
  }
  if (scope === "season") {
    renderSeason();
    return;
  }
  const match = getMatch(currentMatchId);
  if (!match) {
    showError("No match selected.");
    return;
  }
  clearError();
  if (matchMode === "teamsheet") renderTeamsheet(match);
  else if (matchMode === "edit") renderEditView(match);
  else renderMatchView(match);
}

function addNewMatch() {
  if (!canEdit()) return;
  const match = createMatch();
  season.matches.push(match);
  currentMatchId = match.id;
  markDirty();
  renderMatchSelect();
  setScope("matchday");
  setMatchMode("edit");
}

document.querySelector(".scope-nav")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".scope-btn");
  if (!btn?.dataset.scope) return;
  setScope(btn.dataset.scope);
});

els.teamName?.addEventListener("click", () => setScope("season"));

document.querySelector(".modes")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".mode");
  if (!btn || !btn.dataset.mode) return;
  setMatchMode(btn.dataset.mode);
});

els.matchSelect?.addEventListener("change", () => {
  currentMatchId = els.matchSelect.value;
  writeHash();
  render();
});

els.btnNewMatch?.addEventListener("click", addNewMatch);

window.addEventListener("hashchange", () => {
  if (applyingHash) return;
  applyHash();
});

window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

function showSignedIn(user) {
  if (els.authGate) els.authGate.hidden = true;
  if (els.app) els.app.hidden = false;
  if (els.userChip) els.userChip.hidden = false;
  if (els.userName) els.userName.textContent = user?.name || user?.email || "Signed in";
  if (els.userPic) {
    if (user?.picture) {
      els.userPic.src = user.picture;
      els.userPic.hidden = false;
    } else {
      els.userPic.hidden = true;
    }
  }
}

function showSignedOut() {
  if (els.authGate) els.authGate.hidden = false;
  if (els.app) els.app.hidden = true;
  if (els.userChip) els.userChip.hidden = true;
  if (els.btnShare) els.btnShare.hidden = true;
  if (els.shareBanner) els.shareBanner.hidden = true;
  closeShareModal();
  season = null;
  sharedSession = null;
  shareLinks = null;
  appStarted = false;
  dirty = false;
}

function setShareModalError(msg) {
  if (!els.shareModalError) return;
  if (!msg) {
    els.shareModalError.hidden = true;
    els.shareModalError.textContent = "";
    return;
  }
  els.shareModalError.hidden = false;
  els.shareModalError.textContent = msg;
}

function withSharePermission(links, code, userid, permission) {
  return (links ?? []).map((link) => {
    if (link.code !== code) return link;
    return {
      ...link,
      accessedBy: (link.accessedBy ?? []).map((access) =>
        access.userid === userid ? { ...access, permission } : access
      ),
    };
  });
}

function renderAccessedBy(code, accesses = []) {
  if (!accesses.length) return `<p class="share-modal__muted">Not opened by anyone yet.</p>`;
  const sorted = [...accesses].sort((a, b) =>
    String(b.lastAccessedAt || "").localeCompare(String(a.lastAccessedAt || ""))
  );
  const items = sorted
    .map((access) => {
      const label = access.name || access.email || "Unknown user";
      const permission = access.permission === "write" ? "write" : "read";
      const key = `${code}:${access.userid}`;
      const count =
        access.accessCount === 1 ? "Once" : `${access.accessCount || 0} times`;
      const last = access.lastAccessedAt
        ? shareDateFormat.format(new Date(access.lastAccessedAt))
        : "—";
      const email =
        access.name && access.email
          ? ` <span class="share-modal__muted">${escapeHtml(access.email)}</span>`
          : "";
      return `<li>
        <div class="share-modal__person">
          <span class="share-modal__viewer" title="${escapeHtml(access.email || "")}">${escapeHtml(label)}${email}</span>
          <select class="share-modal__permission" data-code="${escapeHtml(code)}" data-userid="${escapeHtml(access.userid)}" aria-label="Permission for ${escapeHtml(label)}" ${shareUpdatingKey === key ? "disabled" : ""}>
            <option value="read" ${permission === "read" ? "selected" : ""}>Can view</option>
            <option value="write" ${permission === "write" ? "selected" : ""}>Can edit</option>
          </select>
        </div>
        <span class="share-modal__muted">${escapeHtml(count)} · last ${escapeHtml(last)}</span>
      </li>`;
    })
    .join("");
  return `<div class="share-modal__access"><span class="share-modal__muted">Accessed by</span><ul>${items}</ul></div>`;
}

function renderShareLinks() {
  if (!els.shareModalBody) return;
  if (shareLinks === null) {
    els.shareModalBody.innerHTML = `<p class="share-modal__muted">Loading share links…</p>`;
    return;
  }
  if (!shareLinks.length) {
    els.shareModalBody.innerHTML = `<p class="share-modal__muted">No share links yet.</p>`;
    return;
  }
  els.shareModalBody.innerHTML = `<ul class="share-modal__list">${shareLinks
    .map((link) => {
      const url = shareUrl(link.code);
      const created = link.createdAt
        ? shareDateFormat.format(new Date(link.createdAt))
        : "—";
      return `<li class="share-modal__link">
        <input readonly aria-label="Share link" value="${escapeHtml(url)}" />
        <div class="share-modal__row">
          <span class="share-modal__muted">Created ${escapeHtml(created)}</span>
          <button type="button" class="btn btn-secondary share-copy" data-code="${escapeHtml(link.code)}">Copy</button>
          <button type="button" class="btn btn-danger share-revoke" data-code="${escapeHtml(link.code)}">Revoke</button>
        </div>
        ${renderAccessedBy(link.code, link.accessedBy)}
      </li>`;
    })
    .join("")}</ul>`;

  els.shareModalBody.querySelectorAll("input[readonly]").forEach((input) => {
    input.addEventListener("focus", () => input.select());
  });
  els.shareModalBody.querySelectorAll(".share-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = btn.dataset.code;
      try {
        await navigator.clipboard.writeText(shareUrl(code));
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1500);
      } catch {
        setShareModalError("Could not copy – select the link and copy it manually.");
      }
    });
  });
  els.shareModalBody.querySelectorAll(".share-revoke").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = btn.dataset.code;
      if (!confirm("Revoke this link? Anyone using it will lose access.")) return;
      setShareModalError(null);
      try {
        await revokeShare(code);
        shareLinks = (shareLinks || []).filter((link) => link.code !== code);
        renderShareLinks();
      } catch (err) {
        setShareModalError(err.message || String(err));
      }
    });
  });
  els.shareModalBody.querySelectorAll(".share-modal__permission").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const code = sel.dataset.code;
      const userid = sel.dataset.userid;
      const permission = sel.value === "write" ? "write" : "read";
      const current = shareLinks
        ?.find((link) => link.code === code)
        ?.accessedBy?.find((access) => access.userid === userid);
      const previous = current?.permission === "write" ? "write" : "read";
      if (permission === previous) return;
      shareUpdatingKey = `${code}:${userid}`;
      setShareModalError(null);
      shareLinks = withSharePermission(shareLinks, code, userid, permission);
      renderShareLinks();
      try {
        await setShareAccess(code, userid, permission);
      } catch (err) {
        shareLinks = withSharePermission(shareLinks, code, userid, previous);
        setShareModalError(err.message || String(err));
        renderShareLinks();
      } finally {
        shareUpdatingKey = null;
        renderShareLinks();
      }
    });
  });
}

async function openShareModal() {
  if (!els.shareModal || isSharedView()) return;
  const title = document.getElementById("share-modal-title");
  if (title) title.textContent = `Share “${season?.teamName || "team"}”`;
  setShareModalError(null);
  shareLinks = null;
  renderShareLinks();
  els.shareModal.hidden = false;
  if (els.shareCreate) els.shareCreate.disabled = true;
  try {
    shareLinks = await listShares();
    renderShareLinks();
  } catch (err) {
    shareLinks = [];
    renderShareLinks();
    setShareModalError(err.message || String(err));
  } finally {
    if (els.shareCreate) els.shareCreate.disabled = false;
  }
}

function closeShareModal() {
  if (els.shareModal) els.shareModal.hidden = true;
}

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  try {
    clearError();
    const shareCode = readShareCode();
    if (shareCode) {
      const loaded = await loadSharedSeason(shareCode);
      sharedSession = { code: shareCode, permission: loaded.permission };
      season = loaded.season;
    } else {
      sharedSession = null;
      let loaded = await loadSeasonDoc();
      if (!loaded) {
        season = await fetchSeedSeason();
        season.setupComplete = !!season.teamName && (season.players?.length || 0) >= 5;
        dirty = true;
        await saveSeasonDoc(season);
        dirty = false;
      } else {
        season = loaded;
      }
    }
    if (!Array.isArray(season.players)) season.players = [];
    if (!Array.isArray(season.matches)) season.matches = [];
    season.quarterMinutes = getQuarterMinutes();
    renderMatchSelect();
    updateShareChrome();

    if (!isSharedView() && needsOnboarding()) {
      setScope("setup", { skipHash: true });
      writeHash();
    } else if (location.hash && location.hash !== "#" && !location.hash.includes("setup")) {
      applyHash();
    } else {
      setScope("matchday", { skipHash: true });
      setMatchMode("match", { skipHash: true });
      writeHash();
    }
    if (dirty) scheduleSave();
  } catch (err) {
    appStarted = false;
    showError(err.message || String(err));
  }
}

els.btnSignOut?.addEventListener("click", () => signOut());
els.btnShare?.addEventListener("click", () => openShareModal());
els.btnLeaveShare?.addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.delete(SHARE_PARAM);
  window.location.href = `${url.pathname}${url.hash || ""}`;
});
els.shareCreate?.addEventListener("click", async () => {
  if (!els.shareCreate) return;
  els.shareCreate.disabled = true;
  setShareModalError(null);
  try {
    if (dirty) await saveSeason();
    const share = await createShare();
    shareLinks = [share, ...(shareLinks || [])];
    renderShareLinks();
  } catch (err) {
    setShareModalError(err.message || String(err));
  } finally {
    els.shareCreate.disabled = false;
  }
});
els.shareModal?.addEventListener("click", (e) => {
  if (e.target.closest("[data-share-close]")) closeShareModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.shareModal && !els.shareModal.hidden) closeShareModal();
});

onAuthChange((sess) => {
  if (sess) {
    showSignedIn(sess.user);
    startApp();
  } else {
    showSignedOut();
  }
});

initAuth({
  buttonEl: els.googleBtn,
  onError: (msg) => {
    if (els.authError) {
      els.authError.hidden = false;
      els.authError.textContent = msg;
    }
  },
});
