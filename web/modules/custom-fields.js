import { state } from "./state.js";
import { escHtml, prettyLabel } from "./utils.js";

const customFieldEntityApiMap = {
  "payment-terms": "payment-term",
  customers: "customer",
  items: "item"
};

const OPTION_BASED_TYPES = new Set(["SELECT", "MULTISELECT"]);

export function getCustomFieldDefinitions(pageKey) {
  return state.cache.customFieldDefinitions[pageKey] || [];
}

export function isOptionBasedType(dataType) {
  return OPTION_BASED_TYPES.has(dataType);
}

export function collectCustomFieldPayload(formData, definitions) {
  const customFields = {};
  definitions
    .filter((definition) => definition.isActive)
    .forEach((definition) => {
      const key = `cf__${definition.fieldKey}`;
      if (definition.dataType === "BOOLEAN") {
        customFields[definition.fieldKey] = formData.has(key);
        return;
      }
      if (definition.dataType === "MULTISELECT") {
        const values = formData.getAll(key).map((v) => String(v).trim()).filter(Boolean);
        if (values.length) customFields[definition.fieldKey] = Array.from(new Set(values));
        return;
      }
      const rawValue = formData.get(key);
      if (rawValue == null) return;
      const value = String(rawValue).trim();
      if (!value.length) return;
      if (definition.dataType === "NUMBER" || definition.dataType === "CURRENCY") {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          customFields[definition.fieldKey] =
            definition.dataType === "CURRENCY" ? Math.round(numeric * 100) / 100 : numeric;
        }
        return;
      }
      customFields[definition.fieldKey] = value;
    });
  return customFields;
}

function htmlInputTypeFor(dataType) {
  switch (dataType) {
    case "NUMBER":
    case "CURRENCY":
      return "number";
    case "DATE":
      return "date";
    case "EMAIL":
      return "email";
    case "URL":
      return "url";
    case "PHONE":
      return "tel";
    default:
      return "text";
  }
}

export function renderCustomFieldInputs(definitions) {
  const activeDefinitions = definitions.filter((definition) => definition.isActive);
  if (!activeDefinitions.length) return "";
  return `
    <div class="list">
      ${activeDefinitions
        .map((definition) => {
          const key = `cf__${definition.fieldKey}`;
          const required = definition.isRequired ? "required" : "";
          const label = escHtml(definition.label);
          const placeholder = escHtml(definition.placeholder || "");
          if (definition.dataType === "SELECT") {
            const options = Array.isArray(definition.optionsJson) ? definition.optionsJson : [];
            return `
              <label>${label}
                <select name="${key}" ${required}>
                  <option value="">Select...</option>
                  ${options.map((option) => `<option value="${escHtml(option)}">${escHtml(option)}</option>`).join("")}
                </select>
              </label>
            `;
          }
          if (definition.dataType === "MULTISELECT") {
            const options = Array.isArray(definition.optionsJson) ? definition.optionsJson : [];
            return `
              <div class="custom-field-multi">
                <span class="custom-field-multi-label">${label}</span>
                <div class="custom-field-multi-options">
                  ${options
                    .map(
                      (option) => `
                    <label class="checkbox-inline">
                      <input type="checkbox" name="${key}" value="${escHtml(option)}" />
                      ${escHtml(option)}
                    </label>
                  `
                    )
                    .join("")}
                </div>
              </div>
            `;
          }
          if (definition.dataType === "BOOLEAN") {
            return `
              <label>
                <input type="checkbox" name="${key}" />
                ${label}
              </label>
            `;
          }
          if (definition.dataType === "TEXTAREA") {
            return `
              <label>${label}
                <textarea name="${key}" rows="3" ${required} placeholder="${placeholder}"></textarea>
              </label>
            `;
          }
          const inputType = htmlInputTypeFor(definition.dataType);
          const stepAttr = definition.dataType === "CURRENCY" ? ' step="0.01"' : "";
          return `
            <label>${label}
              <input name="${key}" type="${inputType}"${stepAttr} ${required} placeholder="${placeholder}" />
            </label>
          `;
        })
        .join("")}
    </div>
  `;
}

export function renderCustomFieldDefinitionRows(pageKey) {
  const definitions = getCustomFieldDefinitions(pageKey);
  if (!definitions.length) {
    return '<div class="empty-state compact"><div><strong>No custom fields</strong><p>Add fields to configure tenant-specific metadata.</p></div></div>';
  }
  return definitions
    .map(
      (definition) => `
      <div class="row">
        <h4>${escHtml(definition.label)}</h4>
        <div class="muted">${escHtml(definition.fieldKey)} · ${escHtml(definition.dataType)}</div>
        <div class="muted">Required: ${definition.isRequired ? "Yes" : "No"} · Order: ${definition.displayOrder}</div>
        <div class="inline-actions wrap">
          <button
            class="custom-field-toggle ghost"
            data-id="${definition.id}"
            data-entity="${customFieldEntityApiMap[pageKey]}"
            data-active="${definition.isActive}"
          >
            ${definition.isActive ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>
    `
    )
    .join("");
}

/**
 * Render a compact filter panel for the active custom field definitions.
 * `filters` is an object keyed by fieldKey (current state). Input names use
 * the `cff__<fieldKey>` pattern so the same form can be parsed back.
 */
export function renderCustomFieldFilters(definitions, filters) {
  const active = definitions.filter((d) => d.isActive);
  if (!active.length) return "";
  return `
    <div class="cf-filter-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--sp-2)">
      ${active
        .map((def) => {
          const key = `cff__${def.fieldKey}`;
          const label = escHtml(def.label);
          const current = filters?.[def.fieldKey];
          if (def.dataType === "SELECT" || def.dataType === "MULTISELECT") {
            const options = Array.isArray(def.optionsJson) ? def.optionsJson : [];
            return `
              <label class="cf-filter-field">${label}
                <select name="${key}">
                  <option value="">Any</option>
                  ${options.map((o) => `<option value="${escHtml(o)}" ${current === o ? "selected" : ""}>${escHtml(o)}</option>`).join("")}
                </select>
              </label>
            `;
          }
          if (def.dataType === "BOOLEAN") {
            return `
              <label class="cf-filter-field">${label}
                <select name="${key}">
                  <option value="" ${!current ? "selected" : ""}>Any</option>
                  <option value="true" ${current === "true" ? "selected" : ""}>Yes</option>
                  <option value="false" ${current === "false" ? "selected" : ""}>No</option>
                </select>
              </label>
            `;
          }
          if (def.dataType === "DATE") {
            const [from, to] = typeof current === "string" ? current.split("..") : ["", ""];
            return `
              <label class="cf-filter-field">${label} (from)
                <input type="date" name="${key}__from" value="${escHtml(from || "")}" />
              </label>
              <label class="cf-filter-field">${label} (to)
                <input type="date" name="${key}__to" value="${escHtml(to || "")}" />
              </label>
            `;
          }
          if (def.dataType === "NUMBER" || def.dataType === "CURRENCY") {
            const [lo, hi] = typeof current === "string" ? current.split("..") : ["", ""];
            return `
              <label class="cf-filter-field">${label} (min)
                <input type="number" step="0.01" name="${key}__min" value="${escHtml(lo || "")}" />
              </label>
              <label class="cf-filter-field">${label} (max)
                <input type="number" step="0.01" name="${key}__max" value="${escHtml(hi || "")}" />
              </label>
            `;
          }
          return `
            <label class="cf-filter-field">${label}
              <input type="text" name="${key}" placeholder="Contains…" value="${escHtml(current || "")}" />
            </label>
          `;
        })
        .join("")}
    </div>
  `;
}

export function collectCustomFieldFilters(formData, definitions) {
  const out = {};
  for (const def of definitions.filter((d) => d.isActive)) {
    const key = `cff__${def.fieldKey}`;
    if (def.dataType === "DATE") {
      const from = String(formData.get(`${key}__from`) || "").trim();
      const to = String(formData.get(`${key}__to`) || "").trim();
      if (from || to) out[def.fieldKey] = `${from}..${to}`;
      continue;
    }
    if (def.dataType === "NUMBER" || def.dataType === "CURRENCY") {
      const lo = String(formData.get(`${key}__min`) || "").trim();
      const hi = String(formData.get(`${key}__max`) || "").trim();
      if (lo || hi) out[def.fieldKey] = `${lo}..${hi}`;
      continue;
    }
    const raw = formData.get(key);
    if (raw == null) continue;
    const v = String(raw).trim();
    if (v.length) out[def.fieldKey] = v;
  }
  return out;
}

export function matchesCustomFieldFilters(record, definitions, filters) {
  if (!filters || !Object.keys(filters).length) return true;
  const values = record?.customFields || {};
  for (const def of definitions.filter((d) => d.isActive)) {
    const filter = filters[def.fieldKey];
    if (filter == null || filter === "") continue;
    const raw = values[def.fieldKey];
    if (def.dataType === "BOOLEAN") {
      const want = filter === "true";
      if (Boolean(raw) !== want) return false;
      continue;
    }
    if (def.dataType === "DATE") {
      const [from, to] = String(filter).split("..");
      if (raw == null || raw === "") return false;
      const ts = new Date(String(raw)).getTime();
      if (from && ts < new Date(from).getTime()) return false;
      if (to && ts > new Date(to).getTime() + 86_400_000 - 1) return false;
      continue;
    }
    if (def.dataType === "NUMBER" || def.dataType === "CURRENCY") {
      const [lo, hi] = String(filter).split("..");
      const n = Number(raw);
      if (!Number.isFinite(n)) return false;
      if (lo !== "" && n < Number(lo)) return false;
      if (hi !== "" && n > Number(hi)) return false;
      continue;
    }
    if (def.dataType === "SELECT") {
      if (String(raw) !== filter) return false;
      continue;
    }
    if (def.dataType === "MULTISELECT") {
      const arr = Array.isArray(raw) ? raw.map(String) : [];
      if (!arr.includes(filter)) return false;
      continue;
    }
    // TEXT / TEXTAREA / EMAIL / URL / PHONE → case-insensitive contains
    const needle = filter.toLowerCase();
    const hay = String(raw ?? "").toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function renderCustomFieldsSummary(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return "";
  const entries = Object.entries(values);
  if (!entries.length) return "";
  return `
    <div class="inline-actions wrap">
      ${entries
        .map(([key, value]) => {
          let display;
          if (typeof value === "boolean") display = value ? "Yes" : "No";
          else if (Array.isArray(value)) display = value.map((v) => escHtml(String(v))).join(", ");
          else display = escHtml(String(value));
          return `<span class="chip">${prettyLabel(key)}: ${display}</span>`;
        })
        .join("")}
    </div>
  `;
}
