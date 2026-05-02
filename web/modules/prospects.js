// Prospects page: list of unidentified-site prospects captured from drop-in
// visits, with actions to identify them as an existing customer, convert to a
// DRAFT customer, or archive. Loaded lazily when the user opens the Prospects
// view to keep the base app shell tiny.
import { qs, views } from "./dom.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { escHtml, asDate } from "./utils.js";

let deps = {
  setStatus: () => {}
};

export function setProspectsDeps(d) {
  deps = { ...deps, ...d };
}

const STATUS_LABELS = {
  UNIDENTIFIED: "Unidentified",
  IDENTIFIED:   "Identified",
  LINKED:       "Linked",
  ARCHIVED:     "Archived"
};

const STATUS_CLS = {
  UNIDENTIFIED: "chip-warning",
  IDENTIFIED:   "chip-primary",
  LINKED:       "chip-success",
  ARCHIVED:     "muted"
};

function ageDays(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
}

export async function loadProspects() {
  const filter = state.prospectFilter || (state.prospectFilter = { status: "UNIDENTIFIED" });
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.search) q.set("search", filter.search);
  q.set("limit", "200");
  const data = await api(`/prospects?${q}`);
  state.cache.prospects = data.rows || [];
  renderProspects();
}

function renderProspects() {
  const root = views.prospects;
  if (!root) return;
  const filter = state.prospectFilter || (state.prospectFilter = { status: "UNIDENTIFIED" });
  const rows = state.cache.prospects || [];
  const staleCount = rows.filter((p) => p.status === "UNIDENTIFIED" && ageDays(p.createdAt) >= 7).length;

  root.innerHTML = `
    <div class="prospects-page">
      <header class="prospects-head">
        <div>
          <h2>Prospects</h2>
          <p class="muted small">Sites captured from drop-in visits — link them to a customer or archive once resolved.</p>
        </div>
        ${staleCount > 0 ? `<div class="prospect-stale-chip" title="Unidentified for 7+ days — please resolve to keep the list clean">${staleCount} stale</div>` : ""}
      </header>
      <div class="prospects-toolbar">
        <div class="prospects-tabs">
          ${["UNIDENTIFIED", "LINKED", "ARCHIVED"].map((s) => `
            <button type="button" class="prospects-tab ${filter.status === s ? "is-active" : ""}" data-prospect-status="${s}">${STATUS_LABELS[s]}</button>
          `).join("")}
          <button type="button" class="prospects-tab ${!filter.status ? "is-active" : ""}" data-prospect-status="">All</button>
        </div>
        <input type="search" class="form-input prospects-search" placeholder="Search name, address, contact…" value="${escHtml(filter.search || "")}" />
      </div>
      <div class="prospects-table-wrap">
        ${rows.length === 0 ? `<div class="empty-state">No prospects to show. Reps create them from the “Unidentified site” option in Add Visit.</div>` : `
          <table class="prospects-table">
            <thead>
              <tr>
                <th>Site / Contact</th>
                <th>Captured by</th>
                <th>Age</th>
                <th>Visits</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(rowHtml).join("")}
            </tbody>
          </table>
        `}
      </div>
    </div>
  `;

  root.querySelectorAll("[data-prospect-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filter.status = btn.dataset.prospectStatus || undefined;
      void loadProspects();
    });
  });
  const search = root.querySelector(".prospects-search");
  search?.addEventListener("input", debounce((e) => {
    filter.search = e.target.value.trim();
    void loadProspects();
  }, 300));
  root.querySelectorAll("[data-prospect-id]").forEach((btn) => {
    btn.addEventListener("click", () => openProspectDetail(btn.dataset.prospectId));
  });
}

function rowHtml(p) {
  const age = ageDays(p.createdAt);
  const isStale = p.status === "UNIDENTIFIED" && age >= 7;
  const subtitle = [p.contactName, p.contactPhone, p.siteAddress].filter(Boolean).join(" · ");
  return `
    <tr class="prospect-row ${isStale ? "is-stale" : ""}">
      <td>
        <div class="prospect-row-name">${escHtml(p.displayName || "(unnamed site)")}</div>
        ${subtitle ? `<div class="muted small">${escHtml(subtitle)}</div>` : ""}
      </td>
      <td>${escHtml(p.createdBy?.fullName || "—")}</td>
      <td class="${isStale ? "stale-cell" : ""}">${age}d</td>
      <td>${p._count?.visits ?? 0}</td>
      <td><span class="chip ${STATUS_CLS[p.status] || ""}">${STATUS_LABELS[p.status] || p.status}</span></td>
      <td><button type="button" class="ghost prospect-open-btn" data-prospect-id="${escHtml(p.id)}">Open</button></td>
    </tr>
  `;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ── Detail modal ────────────────────────────────────────────────────────────
export async function openProspectDetail(prospectId) {
  let detail;
  try {
    detail = await api(`/prospects/${prospectId}`);
  } catch (err) {
    deps.setStatus(err.message || "Could not load prospect.", true);
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "ncm-overlay";
  overlay.id = "prospect-detail-modal";
  // The detail modal owns a local copy of `detail` so re-renders after
  // patch/photo-upload don't re-hit the API. Identify/archive/convert close
  // the modal so they don't need this; edits stay open.
  let current = detail;
  const editable = current.status === "UNIDENTIFIED" || current.status === "IDENTIFIED";

  function paint() {
    overlay.innerHTML = `
      <div class="ncm-panel" role="dialog" aria-modal="true" aria-label="Prospect detail" style="max-width:560px">
        <div class="ncm-header">
          <div>
            <h2 class="ncm-title">${escHtml(current.displayName || "(unnamed site)")}</h2>
            <p class="ncm-subtitle muted small">Status: ${STATUS_LABELS[current.status] || current.status} · Captured ${asDate(current.createdAt)} by ${escHtml(current.createdBy?.fullName || "—")}</p>
          </div>
          <button class="ncm-close" type="button" aria-label="Close">&#x2715;</button>
        </div>
        <div class="ncm-body">
          ${editable ? renderEditableFields(current) : renderReadOnlyFields(current)}
          ${renderVisitsList(current.visits || [])}
          ${renderPhotosSection(current, editable)}
          ${renderLinkedCustomer(current.linkedCustomer)}
        </div>
        <div class="ncm-footer">
          ${editable ? `
            <button type="button" class="ghost" data-act="archive">Archive</button>
            <button type="button" class="ghost" data-act="convert">Convert to draft customer</button>
            <button type="button" data-act="identify">Identify existing customer…</button>
          ` : `
            <button type="button" class="ghost" data-act="close">Close</button>
          `}
        </div>
      </div>
    `;
    bindHandlers();
  }

  function bindHandlers() {
    overlay.querySelector(".ncm-close")?.addEventListener("click", close);
    overlay.querySelector('[data-act="close"]')?.addEventListener("click", close);

    overlay.querySelector('[data-act="archive"]')?.addEventListener("click", async () => {
      if (!confirm("Archive this prospect? It will be hidden from the active list.")) return;
      try {
        await api(`/prospects/${current.id}/archive`, { method: "POST" });
        deps.setStatus("Prospect archived.");
        close();
        await loadProspects();
      } catch (err) {
        deps.setStatus(err.message, true);
      }
    });

    overlay.querySelector('[data-act="convert"]')?.addEventListener("click", async () => {
      const name = prompt("Name for the new DRAFT customer:", current.displayName || "");
      if (name === null) return;
      try {
        const result = await api(`/prospects/${current.id}/convert-to-draft`, {
          method: "POST",
          body: name.trim() ? { name: name.trim() } : {}
        });
        deps.setStatus(`Draft customer created: ${result.draftCustomer.name}`);
        close();
        await loadProspects();
      } catch (err) {
        deps.setStatus(err.message, true);
      }
    });

    overlay.querySelector('[data-act="identify"]')?.addEventListener("click", () => {
      openIdentifyDialog(current, async () => {
        close();
        await loadProspects();
      });
    });

    overlay.querySelector("#prospect-edit-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const payload = {};
      for (const k of ["displayName", "siteAddress", "contactName", "contactPhone", "notes"]) {
        const v = String(fd.get(k) ?? "").trim();
        if (v || (current[k] && !v)) payload[k] = v || null;
      }
      const btn = overlay.querySelector("#prospect-save-btn");
      if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
      try {
        const updated = await api(`/prospects/${current.id}`, { method: "PATCH", body: payload });
        // Server returns just the updated row — preserve relations from `current`.
        current = { ...current, ...updated };
        deps.setStatus("Prospect saved.");
        paint();
      } catch (err) {
        deps.setStatus(err.message, true);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Save details"; }
      }
    });

    overlay.querySelector("#prospect-photo-input")?.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      const status = overlay.querySelector("#prospect-photo-status");
      if (status) status.textContent = `Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…`;
      try {
        for (const file of files) {
          await uploadProspectPhoto(current.id, file);
        }
        // Re-fetch to pick up new photos.
        current = await api(`/prospects/${current.id}`);
        deps.setStatus("Photos uploaded.");
        paint();
      } catch (err) {
        deps.setStatus(err.message, true);
        if (status) status.textContent = "";
      }
    });

    overlay.querySelectorAll("[data-photo-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const result = await api(`/prospects/${current.id}/photos/${btn.dataset.photoId}/download`);
          if (result?.downloadUrl) window.open(result.downloadUrl, "_blank", "noopener");
        } catch (err) {
          deps.setStatus(err.message, true);
        }
      });
    });

    overlay.querySelectorAll("[data-photo-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this photo?")) return;
        try {
          await api(`/prospects/${current.id}/photos/${btn.dataset.photoDelete}`, { method: "DELETE" });
          current = await api(`/prospects/${current.id}`);
          deps.setStatus("Photo deleted.");
          paint();
        } catch (err) {
          deps.setStatus(err.message, true);
        }
      });
    });
  }

  paint();
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("ncm-open"));

  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

async function uploadProspectPhoto(prospectId, file) {
  // 1. Ask the server for a presigned R2 upload URL scoped to this prospect.
  const init = await api(`/prospects/${prospectId}/photos/init`, {
    method: "POST",
    body: { contentType: file.type || "application/octet-stream" }
  });
  // 2. PUT the file directly to R2 (bypasses our server, no body size limits).
  const putRes = await fetch(init.uploadUrl, {
    method: "PUT",
    headers: init.requiredHeaders || {},
    body: file
  });
  if (!putRes.ok) {
    throw new Error(`Photo upload to R2 failed (${putRes.status}).`);
  }
  // 3. Tell the server the upload landed; it persists the ProspectPhoto row.
  await api(`/prospects/${prospectId}/photos`, {
    method: "POST",
    body: {
      objectRef: init.objectRef,
      caption: file.name || undefined
    }
  });
}

function renderEditableFields(p) {
  return `
    <form id="prospect-edit-form" class="ncm-form">
      <div class="ncm-row">
        <div class="ncm-field">
          <label class="ncm-label">Site name</label>
          <input class="ncm-input" name="displayName" value="${escHtml(p.displayName || "")}" maxlength="200" />
        </div>
      </div>
      <div class="ncm-row ncm-row--2">
        <div class="ncm-field">
          <label class="ncm-label">Contact name</label>
          <input class="ncm-input" name="contactName" value="${escHtml(p.contactName || "")}" maxlength="200" />
        </div>
        <div class="ncm-field">
          <label class="ncm-label">Contact phone</label>
          <input class="ncm-input" name="contactPhone" value="${escHtml(p.contactPhone || "")}" maxlength="50" />
        </div>
      </div>
      <div class="ncm-row">
        <div class="ncm-field">
          <label class="ncm-label">Site address</label>
          <input class="ncm-input" name="siteAddress" value="${escHtml(p.siteAddress || "")}" maxlength="500" />
        </div>
      </div>
      <div class="ncm-row">
        <div class="ncm-field">
          <label class="ncm-label">Notes</label>
          <textarea class="ncm-input" name="notes" rows="3" maxlength="4000" style="resize:vertical">${escHtml(p.notes || "")}</textarea>
        </div>
      </div>
      ${p.siteLat != null && p.siteLng != null
        ? `<p class="muted small">Coordinates: ${p.siteLat}, ${p.siteLng} — captured at visit time, not editable here.</p>`
        : ""}
      <div style="display:flex;justify-content:flex-end;margin-top:var(--sp-2)">
        <button type="submit" class="ghost" id="prospect-save-btn">Save details</button>
      </div>
    </form>
  `;
}

function renderReadOnlyFields(p) {
  const rows = [
    p.siteAddress    ? ["Site address", p.siteAddress] : null,
    p.siteLat != null && p.siteLng != null ? ["Coordinates", `${p.siteLat}, ${p.siteLng}`] : null,
    p.contactName    ? ["Contact name",  p.contactName]  : null,
    p.contactPhone   ? ["Contact phone", p.contactPhone] : null,
    p.notes          ? ["Notes",         p.notes]        : null
  ].filter(Boolean);
  if (rows.length === 0) return `<p class="muted small">No additional details captured.</p>`;
  return `<dl class="kv-grid">${rows.map(([k, v]) =>
    `<dt>${escHtml(k)}</dt><dd>${escHtml(String(v))}</dd>`
  ).join("")}</dl>`;
}

function renderVisitsList(visits) {
  if (visits.length === 0) return "";
  return `
    <h4 class="ncm-subhead">Visits (${visits.length})</h4>
    <ul class="prospect-visits-list">
      ${visits.map((v) => `
        <li>
          <span class="chip ${v.status === "CHECKED_OUT" ? "chip-success" : v.status === "CHECKED_IN" ? "chip-primary" : ""}">${escHtml(v.status)}</span>
          <span>${escHtml(v.visitNo || "(no number)")}</span>
          <span class="muted small">${asDate(v.checkInAt || v.plannedAt)}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderPhotosSection(p, editable) {
  const photos = p.photos || [];
  const list = photos.length === 0
    ? `<p class="muted small">No photos captured yet.</p>`
    : `<ul class="prospect-photos-list">
        ${photos.map((ph) => `
          <li>
            <button type="button" class="ghost" data-photo-id="${escHtml(ph.id)}" title="Open photo">${escHtml(ph.caption || `Photo ${asDate(ph.uploadedAt)}`)}</button>
            ${editable ? `<button type="button" class="ghost" data-photo-delete="${escHtml(ph.id)}" title="Delete photo" style="margin-left:var(--sp-1);color:var(--danger)">&#x2715;</button>` : ""}
          </li>
        `).join("")}
      </ul>`;
  // `capture="environment"` hints to mobile browsers to open the rear camera —
  // the common case for a rep on-site. multiple lets them grab a few shots in
  // one go (signage + building + business card).
  const uploader = editable
    ? `<div style="margin-top:var(--sp-2);display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap">
         <input type="file" id="prospect-photo-input" accept="image/*" capture="environment" multiple style="font-size:0.85rem" />
         <span id="prospect-photo-status" class="muted small"></span>
       </div>`
    : "";
  return `
    <h4 class="ncm-subhead">Photos (${photos.length})</h4>
    ${list}
    ${uploader}
  `;
}

function renderLinkedCustomer(customer) {
  if (!customer) return "";
  return `
    <h4 class="ncm-subhead">Linked customer</h4>
    <p>${escHtml(customer.name)}${customer.customerCode ? ` <span class="muted small">${escHtml(customer.customerCode)}</span>` : ""}</p>
  `;
}

function openIdentifyDialog(prospect, onLinked) {
  const overlay = document.createElement("div");
  overlay.className = "ncm-overlay";
  overlay.id = "prospect-identify-modal";
  overlay.innerHTML = `
    <div class="ncm-panel" role="dialog" aria-modal="true" aria-label="Identify customer" style="max-width:480px">
      <div class="ncm-header">
        <h2 class="ncm-title">Identify customer</h2>
        <button class="ncm-close" type="button" aria-label="Close">&#x2715;</button>
      </div>
      <div class="ncm-body">
        <label class="form-label">Search customer
          <input type="search" class="form-input" id="prospect-id-search" placeholder="Name or code…" autocomplete="off" />
        </label>
        <div class="ac-list" id="prospect-id-results" hidden></div>
        <p class="muted small">Visits attached to this prospect will be re-pointed to the chosen customer.</p>
      </div>
      <div class="ncm-footer">
        <button type="button" class="ghost" data-act="cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("ncm-open"));

  const close = () => overlay.remove();
  overlay.querySelector(".ncm-close")?.addEventListener("click", close);
  overlay.querySelector('[data-act="cancel"]')?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const searchEl = overlay.querySelector("#prospect-id-search");
  const resultsEl = overlay.querySelector("#prospect-id-results");
  let lastQuery = "";
  searchEl?.addEventListener("input", debounce(async (e) => {
    const q = e.target.value.trim();
    if (q.length < 2) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
      return;
    }
    if (q === lastQuery) return;
    lastQuery = q;
    try {
      const customers = await api(`/customers/search?q=${encodeURIComponent(q)}&scope=team&limit=12`);
      resultsEl.hidden = false;
      resultsEl.innerHTML = (customers || []).map((c) =>
        `<button type="button" class="ac-item" data-customer-id="${escHtml(c.id)}">${escHtml(c.name)}${c.customerCode ? ` <span class="muted small">(${escHtml(c.customerCode)})</span>` : ""}</button>`
      ).join("") || `<div class="ac-empty muted small">No matches.</div>`;
      resultsEl.querySelectorAll("[data-customer-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await api(`/prospects/${prospect.id}/identify`, {
              method: "POST",
              body: { customerId: btn.dataset.customerId }
            });
            deps.setStatus("Prospect linked to customer. Visits re-pointed.");
            close();
            await onLinked?.();
          } catch (err) {
            deps.setStatus(err.message, true);
          }
        });
      });
    } catch (err) {
      deps.setStatus(err.message, true);
    }
  }, 200));
  searchEl?.focus();
}
