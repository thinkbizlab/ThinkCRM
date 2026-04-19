// WebAuthn helpers — handle the browser-side credential dance for login,
// registration, and admin/self passkey management. The caller is responsible
// for any UI flow that runs after a successful login (token storage, navigation, etc).
import { qs, setStatus } from "./dom.js";
import { api } from "./api.js";
import { base64urlToBuffer, bufferToBase64url, escHtml } from "./utils.js";

// Run a WebAuthn assertion for an existing user, then verify with the server.
// Returns the parsed `{ accessToken, user, needsEmailVerification, ... }` payload.
// Throws on cancellation or any server error.
export async function passkeyLogin({ tenantSlug, email }) {
  const optionsRes = await fetch("/api/v1/auth/passkey/login-options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantSlug, email })
  });
  if (!optionsRes.ok) {
    const err = await optionsRes.json().catch(() => ({}));
    throw new Error(err.message || "Failed to start passkey login.");
  }
  const options = await optionsRes.json();

  const publicKeyOptions = {
    challenge: base64urlToBuffer(options.challenge),
    timeout: options.timeout || 60000,
    rpId: options.rpId,
    userVerification: options.userVerification || "preferred"
  };
  if (options.allowCredentials?.length) {
    publicKeyOptions.allowCredentials = options.allowCredentials.map(c => ({
      id: base64urlToBuffer(c.id),
      type: c.type,
      transports: c.transports
    }));
  }

  const assertion = await navigator.credentials.get({ publicKey: publicKeyOptions });

  const credential = {
    id: assertion.id,
    rawId: bufferToBase64url(assertion.rawId),
    type: assertion.type,
    response: {
      authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
      clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
      signature: bufferToBase64url(assertion.response.signature),
      userHandle: assertion.response.userHandle ? bufferToBase64url(assertion.response.userHandle) : undefined
    },
    clientExtensionResults: assertion.getClientExtensionResults?.() || {},
    authenticatorAttachment: assertion.authenticatorAttachment || undefined
  };

  const verifyRes = await fetch("/api/v1/auth/passkey/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantSlug, email, credential })
  });
  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({}));
    throw new Error(err.message || "Passkey verification failed.");
  }
  return verifyRes.json();
}

// Register a new passkey for the currently authenticated user.
export async function passkeyRegister(deviceName) {
  const options = await api("/auth/passkey/register-options", { method: "POST", body: {} });

  const publicKeyOptions = {
    challenge: base64urlToBuffer(options.challenge),
    rp: { id: options.rp.id, name: options.rp.name },
    user: {
      id: base64urlToBuffer(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName
    },
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout || 60000,
    attestation: options.attestation || "none",
    authenticatorSelection: options.authenticatorSelection,
    excludeCredentials: (options.excludeCredentials || []).map(c => ({
      id: base64urlToBuffer(c.id),
      type: c.type,
      transports: c.transports
    }))
  };

  const credential = await navigator.credentials.create({ publicKey: publicKeyOptions });

  const credentialJSON = {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: bufferToBase64url(credential.response.attestationObject),
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      transports: credential.response.getTransports?.() || []
    },
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    authenticatorAttachment: credential.authenticatorAttachment || undefined
  };

  await api("/auth/passkey/register", {
    method: "POST",
    body: { credential: credentialJSON, deviceName: deviceName || "My passkey" }
  });
}

const PASSKEY_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>`;
const TRASH_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

function renderPasskeyList(passkeys) {
  return passkeys.map(pk => `
    <div class="passkey-item" data-id="${pk.id}">
      <div class="passkey-item-icon">${PASSKEY_ICON_SVG}</div>
      <div class="passkey-item-info">
        <div class="passkey-item-name">${escHtml(pk.deviceName)}</div>
        <div class="passkey-item-meta">Added ${new Date(pk.createdAt).toLocaleDateString()}${pk.lastUsedAt ? " · Last used " + new Date(pk.lastUsedAt).toLocaleDateString() : ""}</div>
      </div>
      <button type="button" class="passkey-delete-btn" data-id="${pk.id}" title="Remove passkey">${TRASH_ICON_SVG}</button>
    </div>
  `).join("");
}

// Admin-side modal: list and delete a specific user's passkeys.
export function openAdminPasskeyModal(userId, userName) {
  const modal = qs("#admin-passkey-modal");
  const body = qs("#admin-passkey-modal-body");
  const title = qs("#admin-passkey-modal-title");
  if (!modal || !body) return;
  title.textContent = `Passkeys — ${userName}`;
  modal.hidden = false;
  body.innerHTML = `<div class="muted">Loading…</div>`;

  async function loadAdminPasskeys() {
    try {
      const { passkeys } = await api(`/auth/users/${userId}/passkeys`);
      if (!passkeys.length) {
        body.innerHTML = `<div class="muted">This user has no passkeys registered.</div>`;
        return;
      }
      body.innerHTML = renderPasskeyList(passkeys);

      body.querySelectorAll(".passkey-delete-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove this passkey? The user won't be able to sign in with it anymore.")) return;
          try {
            await api(`/auth/users/${userId}/passkeys/${btn.dataset.id}`, { method: "DELETE" });
            setStatus("Passkey removed.");
            loadAdminPasskeys();
          } catch (err) {
            setStatus(err.message, true);
          }
        });
      });
    } catch (err) {
      body.innerHTML = `<div class="muted">${escHtml(err.message)}</div>`;
    }
  }

  loadAdminPasskeys();

  const closeBtn = qs("#admin-passkey-modal-close");
  const backdrop = qs("#admin-passkey-modal-backdrop");
  const closeModal = () => { modal.hidden = true; };
  closeBtn?.addEventListener("click", closeModal, { once: true });
  backdrop?.addEventListener("click", closeModal, { once: true });
}

// Self-service section inside Settings → My Profile.
// Renders the current user's passkeys + an "Add passkey" button.
export function initPasskeySection() {
  const listEl = qs("#passkey-list");
  const registerBtn = qs("#passkey-register-btn");
  const msgEl = qs("#passkey-msg");
  if (!listEl) return;

  async function loadPasskeys() {
    try {
      const { passkeys } = await api("/auth/passkeys");
      if (!passkeys.length) {
        listEl.innerHTML = `<div class="muted">No passkeys registered yet.</div>`;
        return;
      }
      listEl.innerHTML = renderPasskeyList(passkeys);

      listEl.querySelectorAll(".passkey-delete-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove this passkey? You won't be able to sign in with it anymore.")) return;
          try {
            await api(`/auth/passkeys/${btn.dataset.id}`, { method: "DELETE" });
            setStatus("Passkey removed.");
            loadPasskeys();
          } catch (err) {
            setStatus(err.message, true);
          }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="muted">${escHtml(err.message)}</div>`;
    }
  }

  loadPasskeys();

  registerBtn?.addEventListener("click", async () => {
    if (msgEl) msgEl.innerHTML = "";
    const deviceName = prompt("Name this passkey (e.g., MacBook, iPhone):", "My passkey");
    if (deviceName === null) return;

    registerBtn.disabled = true;
    registerBtn.textContent = "Registering…";
    try {
      await passkeyRegister(deviceName || "My passkey");
      setStatus("Passkey registered successfully!");
      loadPasskeys();
    } catch (err) {
      if (err.name === "NotAllowedError") {
        if (msgEl) msgEl.innerHTML = `<span class="form-hint" style="color:var(--danger)">Passkey registration was cancelled.</span>`;
      } else {
        if (msgEl) msgEl.innerHTML = `<span class="form-hint" style="color:var(--danger)">${escHtml(err.message)}</span>`;
      }
    } finally {
      registerBtn.disabled = false;
      registerBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add passkey';
    }
  });
}
