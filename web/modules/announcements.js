// User-facing announcement modal: fetches announcements the current user has
// not acknowledged and walks them one at a time. After the user clicks Accept,
// we POST the ack and advance to the next unread item; when the queue is
// empty, the modal hides.
//
// Errors are silent — a network glitch should never block the app.

import { api } from "./api.js";
import { escHtml } from "./utils.js";

const modal = document.getElementById("announcement-modal");
const titleEl = document.getElementById("announcement-modal-title");
const metaEl = document.getElementById("announcement-modal-meta");
const bodyEl = document.getElementById("announcement-modal-body");
const acceptBtn = document.getElementById("announcement-accept-btn");

let queue = [];
let acking = false;

function fmtWhen(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  } catch { return ""; }
}

function paint() {
  if (!modal) return;
  const next = queue[0];
  if (!next) {
    modal.hidden = true;
    return;
  }
  titleEl.textContent = next.title;
  // textContent on the body keeps line breaks via CSS white-space:pre-wrap;
  // it's also XSS-safe — no innerHTML on user-supplied text.
  bodyEl.textContent = next.body;
  const author = next.createdByName ? `by ${next.createdByName}` : "";
  const when = fmtWhen(next.createdAt);
  metaEl.textContent = [author, when].filter(Boolean).join(" • ");
  modal.hidden = false;
}

async function ackTop() {
  if (acking) return;
  const current = queue[0];
  if (!current) return;
  acking = true;
  acceptBtn.disabled = true;
  try {
    await api(`/announcements/${encodeURIComponent(current.id)}/ack`, { method: "POST" });
    queue.shift();
    paint();
  } catch {
    // Surface nothing intrusive — leave the modal up so the user can retry.
  } finally {
    acking = false;
    acceptBtn.disabled = false;
  }
}

if (acceptBtn) {
  acceptBtn.addEventListener("click", ackTop);
}

// Public API: call after login or on bootstrap. Safe to call repeatedly —
// concurrent calls are de-duped via the acking flag and an idempotent server.
export async function checkUnreadAnnouncements() {
  if (!modal) return;
  try {
    const list = await api("/announcements/unread");
    queue = Array.isArray(list) ? list.slice() : [];
    paint();
  } catch {
    // Silent failure — re-runs next session.
  }
}

// Admin helpers — wired by the Settings page.

export async function adminListAnnouncements() {
  return api("/announcements");
}

export async function adminCreateAnnouncement({ title, body, roles }) {
  return api("/announcements", {
    method: "POST",
    body: { title, body, roles: Array.isArray(roles) ? roles : [] }
  });
}

export async function adminUpdateAnnouncement(id, { title, body, roles }) {
  const payload = {};
  if (title !== undefined) payload.title = title;
  if (body !== undefined) payload.body = body;
  if (roles !== undefined) payload.roles = Array.isArray(roles) ? roles : [];
  return api(`/announcements/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
}

export async function adminDeleteAnnouncement(id) {
  return api(`/announcements/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function adminListAcks(id) {
  return api(`/announcements/${encodeURIComponent(id)}/acks`);
}

// Roles available for targeting. Order mirrors the role rank used elsewhere
// in the admin UI (highest first), so the most-restrictive choices appear
// at the top of the multi-select.
const ROLE_OPTIONS = [
  { value: "ADMIN",             label: "Admin" },
  { value: "DIRECTOR",          label: "Director" },
  { value: "MANAGER",           label: "Manager" },
  { value: "ASSISTANT_MANAGER", label: "Assistant Manager" },
  { value: "SUPERVISOR",        label: "Supervisor" },
  { value: "SALES_ADMIN",       label: "Sales Admin" },
  { value: "REP",               label: "Rep" }
];

function roleLabel(value) {
  return ROLE_OPTIONS.find((r) => r.value === value)?.label || value;
}

function describeAudience(roles) {
  if (!roles || roles.length === 0) return "Everyone";
  return roles.map(roleLabel).join(", ");
}

// Build the admin Settings page contents. Returned as a string the settings
// renderer drops into the page body; events are wired by `wireAdminPage()`.
export function renderAdminPageHtml({ totalActiveUsers, announcements }) {
  const rows = announcements.map((a) => {
    const audience = a.audienceSize ?? totalActiveUsers ?? 0;
    const reach = audience > 0 ? `${a.ackCount} / ${audience}` : `${a.ackCount}`;
    return `
      <tr data-announcement-id="${escHtml(a.id)}">
        <td><strong>${escHtml(a.title)}</strong><div class="muted small" style="white-space:pre-wrap;margin-top:4px">${escHtml(a.body)}</div></td>
        <td class="muted small">${escHtml(describeAudience(a.roles))}</td>
        <td class="muted small">${escHtml(a.createdBy?.fullName || "—")}<br>${escHtml(fmtWhen(a.createdAt))}</td>
        <td>${escHtml(reach)} accepted</td>
        <td style="white-space:nowrap">
          <button type="button" class="ghost" data-announcement-acks="${escHtml(a.id)}">View log</button>
          <button type="button" class="btn-danger" data-announcement-delete="${escHtml(a.id)}">Delete</button>
        </td>
      </tr>
    `;
  }).join("");

  const roleCheckboxes = ROLE_OPTIONS.map((r) => `
    <label class="role-checkbox" style="display:inline-flex;align-items:center;gap:6px;margin-right:var(--sp-3)">
      <input type="checkbox" name="role" value="${escHtml(r.value)}" />
      <span>${escHtml(r.label)}</span>
    </label>
  `).join("");

  return `
    <div class="settings-section">
      <header class="settings-section-head">
        <div>
          <h3>Announcements</h3>
          <p class="muted small">Broadcast a message to users in this workspace. Each targeted user sees a modal until they click Accept; the timestamp is logged.</p>
        </div>
      </header>

      <form id="announcement-create-form" class="card" style="padding:var(--sp-3);display:grid;gap:var(--sp-2);margin-bottom:var(--sp-3)">
        <label class="form-label">Title
          <input class="form-input" name="title" required maxlength="200" placeholder="e.g. Scheduled maintenance Saturday 9pm" />
        </label>
        <label class="form-label">Message
          <textarea class="form-input" name="body" required maxlength="5000" rows="4" placeholder="What do you want everyone to read and acknowledge?"></textarea>
        </label>
        <div>
          <span class="form-label" style="margin-bottom:6px;display:block">Audience</span>
          <p class="muted small" style="margin:0 0 6px">Leave all unchecked to send to <strong>everyone</strong>. Tick specific roles to narrow it.</p>
          <div id="announcement-roles-row" style="display:flex;flex-wrap:wrap;row-gap:6px">${roleCheckboxes}</div>
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button type="submit">Publish announcement</button>
        </div>
      </form>

      ${announcements.length ? `
        <table class="data-table">
          <thead>
            <tr>
              <th>Announcement</th>
              <th>Audience</th>
              <th>Posted by</th>
              <th>Reach</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      ` : `<p class="muted">No announcements yet.</p>`}

      <div id="announcement-acks-panel" class="card" hidden style="padding:var(--sp-3);margin-top:var(--sp-3)">
        <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-2)">
          <h4 id="announcement-acks-title" style="margin:0">Acceptance log</h4>
          <button type="button" class="ghost" id="announcement-acks-close">Close</button>
        </header>
        <div id="announcement-acks-body"></div>
      </div>
    </div>
  `;
}

// Wire up the form and per-row buttons inside the Settings page. Caller must
// pass a `reload` callback that re-fetches and re-renders the page when the
// list changes.
export function wireAdminPage({ reload, setStatus }) {
  const form = document.getElementById("announcement-create-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = (fd.get("title") || "").toString().trim();
      const body = (fd.get("body") || "").toString().trim();
      const roles = fd.getAll("role").map((r) => r.toString());
      if (!title || !body) return;
      try {
        await adminCreateAnnouncement({ title, body, roles });
        setStatus("Announcement published.");
        await reload();
      } catch (err) {
        setStatus(err.message || "Failed to publish.", true);
      }
    });
  }

  document.querySelectorAll("[data-announcement-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-announcement-delete");
      if (!id) return;
      if (!confirm("Delete this announcement? Acceptance log will also be removed.")) return;
      try {
        await adminDeleteAnnouncement(id);
        setStatus("Announcement deleted.");
        await reload();
      } catch (err) {
        setStatus(err.message || "Failed to delete.", true);
      }
    });
  });

  const acksPanel = document.getElementById("announcement-acks-panel");
  const acksTitle = document.getElementById("announcement-acks-title");
  const acksBody = document.getElementById("announcement-acks-body");
  const acksClose = document.getElementById("announcement-acks-close");

  document.querySelectorAll("[data-announcement-acks]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-announcement-acks");
      if (!id || !acksPanel) return;
      acksPanel.hidden = false;
      acksBody.innerHTML = `<p class="muted">Loading…</p>`;
      const row = btn.closest("tr");
      const titleText = row?.querySelector("strong")?.textContent || "Announcement";
      acksTitle.textContent = `Acceptance log — ${titleText}`;
      try {
        const list = await adminListAcks(id);
        if (!list.length) {
          acksBody.innerHTML = `<p class="muted">Nobody has accepted this announcement yet.</p>`;
          return;
        }
        acksBody.innerHTML = `
          <table class="data-table">
            <thead><tr><th>User</th><th>Email</th><th>Accepted at</th></tr></thead>
            <tbody>
              ${list.map((a) => `
                <tr>
                  <td>${escHtml(a.user?.fullName || "—")}</td>
                  <td class="muted">${escHtml(a.user?.email || "")}</td>
                  <td>${escHtml(fmtWhen(a.acknowledgedAt))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>`;
      } catch (err) {
        acksBody.innerHTML = `<p class="muted" style="color:var(--danger)">${escHtml(err.message || "Failed to load")}</p>`;
      }
    });
  });

  if (acksClose && acksPanel) {
    acksClose.addEventListener("click", () => { acksPanel.hidden = true; });
  }
}
