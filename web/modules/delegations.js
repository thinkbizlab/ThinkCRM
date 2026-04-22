// Delegations UI — renders the "Delegations" subsection on Settings → Roles
// and wires the create/edit/revoke modal. A delegation grants a Sales Admin or
// Assistant Manager the right to act on behalf of one or more principals
// (Reps/Supervisors/Managers/Directors) between startsAt and endsAt.
//
// App-level helpers (setStatus, escHtml, renderSettings) are injected via
// setDelegationsDeps() so this module stays decoupled from app.js.

import { api } from "./api.js";
import { state } from "./state.js";
import { icon } from "./icons.js";

let deps = {
  setStatus: () => {},
  escHtml: (s) => String(s ?? ""),
  renderSettings: () => {}
};

export function setDelegationsDeps(d) {
  deps = { ...deps, ...d };
}

export async function loadDelegations() {
  try {
    const res = await api("/settings/delegations");
    state.cache.delegations = Array.isArray(res) ? res : (res?.data ?? []);
  } catch {
    state.cache.delegations = [];
  }
}

// Load the current user's active principals (users they can act on behalf of).
// Cached on state.cache.myPrincipals so forms don't re-fetch on every open.
export async function loadMyPrincipals() {
  try {
    state.cache.myPrincipals = await api("/users/me/principals");
  } catch {
    state.cache.myPrincipals = [];
  }
  return state.cache.myPrincipals;
}

export function canActOnBehalf() {
  const role = state.user?.role;
  return role === "SALES_ADMIN" || role === "ASSISTANT_MANAGER";
}

// Returns the currently selected principal from an on-behalf-of select in
// the given form container. Null means "acting as self".
export function readOnBehalfOfValue(container) {
  const sel = container?.querySelector?.('[name="onBehalfOfUserId"]');
  const v = sel?.value;
  return v && v !== "__self__" ? v : null;
}

// Injects the on-behalf-of <select> into the given container element (typically
// a <form> or a field wrapper). No-op unless the current user is a delegate
// role AND has at least one active principal.
export async function attachOnBehalfOfField(container, { label } = {}) {
  if (!container || !canActOnBehalf()) return null;
  if (container.querySelector('[name="onBehalfOfUserId"]')) {
    // already rendered for this form — just refresh the options
  }
  const principals = state.cache.myPrincipals ?? await loadMyPrincipals();
  if (!principals.length) return null;

  const existing = container.querySelector(".on-behalf-of-wrap");
  if (existing) existing.remove();

  const { escHtml } = deps;
  const wrap = document.createElement("label");
  wrap.className = "form-label on-behalf-of-wrap";
  wrap.innerHTML = `
    ${label ?? "Acting on behalf of"}
    <select class="form-input" name="onBehalfOfUserId">
      <option value="__self__">${escHtml(state.user?.fullName || "Myself")} (myself)</option>
      ${principals.map((p) => `<option value="${p.id}">${escHtml(p.fullName)}${p.role ? ` · ${escHtml(p.role)}` : ""}</option>`).join("")}
    </select>
    <span class="muted small" style="margin-top:4px">Record will be owned by the selected user. You remain logged as the creator.</span>
  `;
  container.prepend(wrap);
  return wrap;
}

const DELEGATE_ROLES = new Set(["SALES_ADMIN", "ASSISTANT_MANAGER"]);
const ROLE_LABEL = {
  ADMIN: "Admin",
  DIRECTOR: "Sales Director",
  MANAGER: "Sales Manager",
  ASSISTANT_MANAGER: "Assistant Manager",
  SUPERVISOR: "Supervisor",
  SALES_ADMIN: "Sales Admin",
  REP: "Sales Rep"
};

const FAR_FUTURE_ISO = "9999-12-31";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function isOpenEnded(endsAtIso) {
  if (!endsAtIso) return true;
  return endsAtIso.startsWith("9999");
}

function groupByDelegate(rows) {
  const { escHtml } = deps;
  const map = new Map();
  for (const r of rows) {
    const key = r.delegate?.id ?? r.delegateUserId;
    if (!map.has(key)) {
      map.set(key, {
        delegate: r.delegate ?? { id: r.delegateUserId, fullName: "—", role: "" },
        items: []
      });
    }
    map.get(key).items.push(r);
  }
  return [...map.values()];
}

// Render the Delegations subsection that is inserted below the main users
// table on the Roles & Permissions page.
export function renderDelegationsSection() {
  const { escHtml } = deps;
  const rows = state.cache.delegations ?? [];
  const groups = groupByDelegate(rows);

  const body = groups.length
    ? groups.map(({ delegate, items }) => {
        const delegateRole = ROLE_LABEL[delegate.role] ?? delegate.role ?? "";
        const rowsHtml = items.map((d) => {
          const principalName = escHtml(d.principal?.fullName ?? d.principalUserId);
          const principalRole = ROLE_LABEL[d.principal?.role] ?? d.principal?.role ?? "";
          const starts = fmtDate(d.startsAt);
          const ends = isOpenEnded(d.endsAt) ? "—" : fmtDate(d.endsAt);
          const now = Date.now();
          const active = (!d.startsAt || new Date(d.startsAt).getTime() <= now) &&
                         (isOpenEnded(d.endsAt) || new Date(d.endsAt).getTime() > now);
          return `
            <div class="deleg-row" data-id="${d.id}">
              <span class="deleg-principal">
                ${icon('user')} <strong>${principalName}</strong>
                <span class="muted small">· ${escHtml(principalRole)}</span>
              </span>
              <span class="deleg-dates muted small">${starts} → ${ends}</span>
              <span>${active ? '<span class="chip chip-success">Active</span>' : '<span class="chip">Inactive</span>'}</span>
              <span class="deleg-actions">
                <button type="button" class="ghost small deleg-edit-btn" data-id="${d.id}">Edit</button>
                <button type="button" class="ghost small deleg-revoke-btn" data-id="${d.id}" style="color:var(--clr-danger,#dc2626)">Revoke</button>
              </span>
            </div>`;
        }).join("");
        return `
          <div class="deleg-group">
            <div class="deleg-group-head">
              <span>${icon('user')} <strong>${escHtml(delegate.fullName)}</strong>
                <span class="muted small">· ${escHtml(delegateRole)}</span>
              </span>
              <span class="muted small">${items.length} principal${items.length === 1 ? "" : "s"}</span>
            </div>
            ${rowsHtml}
          </div>`;
      }).join("")
    : `<div class="empty-state compact"><div><strong>No delegations yet</strong><p class="muted small">Delegations let Sales Admin or Assistant Manager act on behalf of their principals.</p></div></div>`;

  return `
    <section class="card deleg-section" style="margin-top:var(--sp-4)">
      <div class="section-head" style="margin-bottom:var(--sp-3);display:flex;justify-content:space-between;align-items:center">
        <h3 class="section-title" style="margin:0">${icon('user')} Delegations</h3>
        <button type="button" class="primary small" id="deleg-add-btn">+ Add Delegation</button>
      </div>
      <p class="muted small" style="margin-bottom:var(--sp-3)">
        Grant a Sales Admin or Assistant Manager the right to act on behalf of another user. The delegate can create records, edit, and view data as if they were the principal — but approval actions are always blocked.
      </p>
      ${body}
    </section>`;
}

function openDelegationModal({ editing } = {}) {
  const { escHtml, renderSettings, setStatus } = deps;
  const users = state.cache.allUsers ?? [];
  const delegates = users.filter((u) => DELEGATE_ROLES.has(u.role));
  const principals = users.filter((u) => !DELEGATE_ROLES.has(u.role) && u.role !== "ADMIN");

  const row = editing ? (state.cache.delegations ?? []).find((d) => d.id === editing) : null;

  const overlay = document.createElement("div");
  overlay.className = "popup-overlay";
  overlay.innerHTML = `
    <div class="popup-box" role="dialog" aria-modal="true">
      <div class="popup-header">
        <p class="popup-title">${row ? "Edit Delegation" : "Add Delegation"}</p>
        <button class="popup-close-btn" aria-label="Close">${icon('x', 14)}</button>
      </div>
      <form id="deleg-form" style="display:flex;flex-direction:column;gap:var(--sp-3);padding:var(--sp-3) 0">
        <label class="form-label">Delegate (Sales Admin or Assistant Manager)
          <select class="form-input" name="delegateUserId" required ${row ? "disabled" : ""}>
            ${row ? "" : '<option value="">— choose delegate —</option>'}
            ${delegates.map((u) => `<option value="${u.id}" ${row && row.delegateUserId === u.id ? "selected" : ""}>${escHtml(u.fullName)} · ${escHtml(ROLE_LABEL[u.role] ?? u.role)}</option>`).join("")}
          </select>
          ${delegates.length === 0 ? '<span class="muted small" style="margin-top:4px">No users with Sales Admin or Assistant Manager role yet.</span>' : ""}
        </label>
        <label class="form-label">Acts on behalf of (principal)
          <select class="form-input" name="principalUserId" required ${row ? "disabled" : ""}>
            ${row ? "" : '<option value="">— choose principal —</option>'}
            ${principals.map((u) => `<option value="${u.id}" ${row && row.principalUserId === u.id ? "selected" : ""}>${escHtml(u.fullName)} · ${escHtml(ROLE_LABEL[u.role] ?? u.role)}</option>`).join("")}
          </select>
        </label>
        <div class="settings-field-row" style="gap:var(--sp-3)">
          <label class="form-label" style="flex:1">Starts
            <input class="form-input" name="startsAt" type="date" value="${fmtDate(row?.startsAt) || new Date().toISOString().slice(0,10)}" required />
          </label>
          <label class="form-label" style="flex:1">Ends
            <input class="form-input" name="endsAt" type="date" value="${fmtDate(row?.endsAt) || FAR_FUTURE_ISO}" required />
            <span class="muted small" style="margin-top:4px">Use 9999-12-31 for no expiry.</span>
          </label>
        </div>
        <p class="deleg-form-msg muted small" style="min-height:1.2em"></p>
        <div class="popup-actions">
          <button type="button" class="popup-cancel-btn">Cancel</button>
          <button type="submit">${row ? "Save" : "Create"}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("popup-visible"));

  const close = () => {
    overlay.classList.remove("popup-visible");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
  };
  overlay.querySelector(".popup-close-btn").addEventListener("click", close);
  overlay.querySelector(".popup-cancel-btn").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  overlay.querySelector("#deleg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const msg = overlay.querySelector(".deleg-form-msg");
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    msg.textContent = "Saving…";
    msg.style.color = "";
    try {
      const startsAt = form.startsAt.value ? new Date(form.startsAt.value + "T00:00:00").toISOString() : undefined;
      const endsAt = form.endsAt.value ? new Date(form.endsAt.value + "T23:59:59").toISOString() : undefined;
      if (row) {
        await api(`/settings/delegations/${row.id}`, { method: "PATCH", body: { startsAt, endsAt } });
      } else {
        await api("/settings/delegations", {
          method: "POST",
          body: {
            delegateUserId: form.delegateUserId.value,
            principalUserId: form.principalUserId.value,
            startsAt,
            endsAt
          }
        });
      }
      await loadDelegations();
      renderSettings();
      setStatus(row ? "Delegation updated." : "Delegation created.");
      close();
    } catch (err) {
      msg.textContent = err.message || "Failed to save delegation.";
      msg.style.color = "var(--clr-danger)";
      btn.disabled = false;
    }
  });
}

// Wire the Add / Edit / Revoke buttons rendered by renderDelegationsSection.
// Called from app.js inside attachSettingsListeners after the Roles page
// has been written into the DOM.
export function wireDelegationsListeners(root) {
  const { setStatus, renderSettings } = deps;

  root.querySelector("#deleg-add-btn")?.addEventListener("click", () => openDelegationModal());

  root.querySelectorAll(".deleg-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openDelegationModal({ editing: btn.dataset.id }));
  });

  root.querySelectorAll(".deleg-revoke-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Revoke this delegation? The delegate will immediately lose access to the principal's data.")) return;
      try {
        await api(`/settings/delegations/${btn.dataset.id}`, { method: "DELETE" });
        await loadDelegations();
        renderSettings();
        setStatus("Delegation revoked.");
      } catch (err) {
        setStatus(err.message || "Failed to revoke delegation.", true);
      }
    });
  });
}
