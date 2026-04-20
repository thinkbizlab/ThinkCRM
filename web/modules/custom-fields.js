import { state } from "./state.js";
import { escHtml, prettyLabel } from "./utils.js";

const customFieldEntityApiMap = {
  "payment-terms": "payment-term",
  customers: "customer",
  items: "item"
};

export function getCustomFieldDefinitions(pageKey) {
  return state.cache.customFieldDefinitions[pageKey] || [];
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
      const rawValue = formData.get(key);
      if (rawValue == null) return;
      const value = String(rawValue).trim();
      if (!value.length) return;
      if (definition.dataType === "NUMBER") {
        customFields[definition.fieldKey] = Number(value);
        return;
      }
      customFields[definition.fieldKey] = value;
    });
  return customFields;
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
          if (definition.dataType === "SELECT") {
            const options = Array.isArray(definition.optionsJson) ? definition.optionsJson : [];
            return `
              <label>${escHtml(definition.label)}
                <select name="${key}" ${required}>
                  <option value="">Select...</option>
                  ${options.map((option) => `<option value="${escHtml(option)}">${escHtml(option)}</option>`).join("")}
                </select>
              </label>
            `;
          }
          if (definition.dataType === "BOOLEAN") {
            return `
              <label>
                <input type="checkbox" name="${key}" />
                ${escHtml(definition.label)}
              </label>
            `;
          }
          const inputType = definition.dataType === "NUMBER" ? "number" : definition.dataType === "DATE" ? "date" : "text";
          return `
            <label>${escHtml(definition.label)}
              <input name="${key}" type="${inputType}" ${required} placeholder="${escHtml(definition.placeholder || "")}" />
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

export function renderCustomFieldsSummary(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return "";
  const entries = Object.entries(values);
  if (!entries.length) return "";
  return `
    <div class="inline-actions wrap">
      ${entries
        .map(
          ([key, value]) =>
            `<span class="chip">${prettyLabel(key)}: ${typeof value === "boolean" ? (value ? "Yes" : "No") : escHtml(String(value))}</span>`
        )
        .join("")}
    </div>
  `;
}
