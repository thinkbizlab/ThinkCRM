// Voice-note modal: record/upload audio, run optional browser STT,
// upload to /voice-notes, then let the user review + confirm a summary.
import { qs, setStatus } from "./dom.js";
import { api } from "./api.js";

const voiceNoteState = {
  onClose: null,
  entityType: null,
  entityId: null,
  jobId: null,
  mediaRecorder: null,
  chunks: [],
  stream: null,
  initBound: false,
  aiAvailable: null,   // null = not yet checked, true/false = cached result
  recognition: null,   // SpeechRecognition instance
  transcript: "",      // accumulated browser speech-to-text transcript
  outputLang: "TH",    // "TH" | "EN" — default Thai
  processing: false    // true while upload/summarize is in flight
};

function getVoiceNoteEls() {
  const root = qs("#voice-note-modal");
  if (!root) return null;
  return {
    root,
    subtitle: qs("#voice-note-modal-subtitle"),
    aiWarning: qs("#voice-note-ai-warning"),
    recordBtn: qs("#voice-note-record"),
    stopBtn: qs("#voice-note-stop"),
    status: qs("#voice-note-status"),
    review: qs("#voice-note-review"),
    transcript: qs("#voice-note-transcript"),
    summary: qs("#voice-note-summary"),
    confirmBtn: qs("#voice-note-confirm"),
    fileInput: qs("#voice-note-file")
  };
}

function setVoiceNoteStatus(text, isError = false) {
  const els = getVoiceNoteEls();
  if (!els?.status) return;
  els.status.textContent = text || "";
  els.status.style.color = isError ? "#b91c1c" : "";
}

function stopVoiceNoteMedia() {
  if (voiceNoteState.mediaRecorder && voiceNoteState.mediaRecorder.state !== "inactive") {
    try {
      voiceNoteState.mediaRecorder.stop();
    } catch {
      /* ignore */
    }
  }
  voiceNoteState.mediaRecorder = null;
  voiceNoteState.chunks = [];
  if (voiceNoteState.stream) {
    voiceNoteState.stream.getTracks().forEach((t) => t.stop());
    voiceNoteState.stream = null;
  }
  if (voiceNoteState.recognition) {
    try { voiceNoteState.recognition.abort(); } catch { /* ignore */ }
    voiceNoteState.recognition = null;
  }
}

function resetVoiceNoteModal() {
  const els = getVoiceNoteEls();
  if (!els) return;
  stopVoiceNoteMedia();
  voiceNoteState.jobId = null;
  voiceNoteState.transcript = "";
  voiceNoteState.processing = false;
  els.review.hidden = true;
  els.transcript.value = "";
  els.transcript.disabled = false;
  els.summary.value = "";
  els.fileInput.value = "";
  els.recordBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.confirmBtn.disabled = false;
  setVoiceNoteStatus("");
}

// Register a one-shot callback fired when the modal is closed (next close only).
export function setVoiceNoteOnClose(fn) {
  voiceNoteState.onClose = fn || null;
}

export async function openVoiceNoteModal(entityType, entityId, subtitle) {
  const els = getVoiceNoteEls();
  if (!els) return;
  resetVoiceNoteModal();
  voiceNoteState.entityType = entityType;
  voiceNoteState.entityId = entityId;
  els.subtitle.textContent = subtitle ? `${entityType} · ${subtitle}` : entityType;
  els.root.hidden = false;

  if (voiceNoteState.aiAvailable === null) {
    try {
      const status = await api("/ai/status");
      voiceNoteState.aiAvailable = status.transcriptionAvailable === true;
    } catch {
      voiceNoteState.aiAvailable = false;
    }
  }
  els.aiWarning.hidden = voiceNoteState.aiAvailable !== false;
}

function closeVoiceNoteModal() {
  if (voiceNoteState.processing) return;
  const els = getVoiceNoteEls();
  if (!els) return;
  resetVoiceNoteModal();
  els.root.hidden = true;
  const cb = voiceNoteState.onClose;
  voiceNoteState.onClose = null;
  if (cb) cb();
}

function lockVoiceNoteModal() {
  voiceNoteState.processing = true;
  const els = getVoiceNoteEls();
  if (!els) return;
  els.recordBtn.disabled = true;
  els.stopBtn.disabled = true;
  els.confirmBtn.disabled = true;
  els.fileInput.disabled = true;
  els.root.querySelectorAll("[data-voice-note-close]").forEach(el => el.setAttribute("disabled", "true"));
}

function unlockVoiceNoteModal() {
  voiceNoteState.processing = false;
  const els = getVoiceNoteEls();
  if (!els) return;
  els.confirmBtn.disabled = false;
  els.fileInput.disabled = false;
  els.root.querySelectorAll("[data-voice-note-close]").forEach(el => el.removeAttribute("disabled"));
}

async function uploadVoiceNoteAudio(blob, filename) {
  if (!voiceNoteState.entityType || !voiceNoteState.entityId) return;
  const aiReady = voiceNoteState.aiAvailable === true;
  const hasTranscript = Boolean(voiceNoteState.transcript);
  lockVoiceNoteModal();
  setVoiceNoteStatus(aiReady && hasTranscript ? "Uploading and summarizing…" : "Uploading audio…");
  try {
    const form = new FormData();
    form.append("entityType", voiceNoteState.entityType);
    form.append("entityId", voiceNoteState.entityId);
    form.append("audio", blob, filename || "voice-note.webm");
    if (voiceNoteState.transcript) form.append("transcriptText", voiceNoteState.transcript);
    form.append("outputLang", voiceNoteState.outputLang);
    const job = await api("/voice-notes", { method: "POST", body: form });
    const els2 = getVoiceNoteEls();
    if (els2) {
      voiceNoteState.jobId = job.id;
      els2.transcript.value = job.transcript?.transcriptText ?? "";
      els2.transcript.disabled = false;
      els2.summary.value = job.transcript?.summaryText ?? "";
      els2.review.hidden = false;
    }
    setVoiceNoteStatus(
      aiReady && hasTranscript
        ? "Review and edit, then confirm to save."
        : aiReady
          ? "No speech detected. Enter notes manually and confirm to save."
          : "Audio uploaded. Enter visit notes and confirm to save."
    );
  } catch (error) {
    setVoiceNoteStatus(error.message, true);
    const els2 = getVoiceNoteEls();
    if (els2) els2.recordBtn.disabled = false;
  } finally {
    unlockVoiceNoteModal();
  }
}

async function startVoiceNoteRecording() {
  const els = getVoiceNoteEls();
  if (!els || !navigator.mediaDevices?.getUserMedia) {
    setVoiceNoteStatus("Recording is not available in this browser. Use “Upload file”.", true);
    return;
  }
  if (!window.MediaRecorder) {
    setVoiceNoteStatus("MediaRecorder is not supported. Use “Upload file”.", true);
    return;
  }
  try {
    voiceNoteState.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const PREFERRED_TYPES = [
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus"
    ];
    const mime = PREFERRED_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || "";
    voiceNoteState.chunks = [];
    try {
      voiceNoteState.mediaRecorder = new MediaRecorder(voiceNoteState.stream, ...(mime ? [{ mimeType: mime }] : []));
    } catch {
      voiceNoteState.mediaRecorder = new MediaRecorder(voiceNoteState.stream);
    }
    voiceNoteState.mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) voiceNoteState.chunks.push(ev.data);
    };
    voiceNoteState.mediaRecorder.start();

    voiceNoteState.transcript = "";
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition && voiceNoteState.aiAvailable) {
      try {
        const recog = new SpeechRecognition();
        recog.continuous = true;
        recog.interimResults = false;
        recog.lang = voiceNoteState.outputLang === "TH" ? "th-TH" : "en-US";
        recog.onresult = (ev) => {
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            if (ev.results[i].isFinal) {
              voiceNoteState.transcript += (voiceNoteState.transcript ? " " : "") + ev.results[i][0].transcript.trim();
            }
          }
        };
        recog.onerror = () => { /* silently ignore — audio still uploads */ };
        recog.start();
        voiceNoteState.recognition = recog;
      } catch {
        voiceNoteState.recognition = null;
      }
    }

    els.recordBtn.disabled = true;
    els.confirmBtn.disabled = true;
    els.fileInput.disabled = true;
    els.root.querySelectorAll("[data-voice-note-close]").forEach(el => el.setAttribute("disabled", "true"));
    els.stopBtn.disabled = false;
    els.stopBtn.textContent = voiceNoteState.aiAvailable ? "Stop & transcribe" : "Stop & upload";
    setVoiceNoteStatus("Recording… click Stop when finished.");
  } catch (error) {
    setVoiceNoteStatus(error.message || "Could not access microphone.", true);
    stopVoiceNoteMedia();
    unlockVoiceNoteModal();
    els.recordBtn.disabled = false;
  }
}

function stopVoiceNoteRecording() {
  const els = getVoiceNoteEls();
  if (!els || !voiceNoteState.mediaRecorder) return;
  const mr = voiceNoteState.mediaRecorder;
  if (mr.state === "inactive") return;
  els.stopBtn.disabled = true;
  setVoiceNoteStatus("Processing recording…");
  if (voiceNoteState.recognition) {
    try { voiceNoteState.recognition.stop(); } catch { /* ignore */ }
    voiceNoteState.recognition = null;
  }
  mr.addEventListener(
    "stop",
    async () => {
      voiceNoteState.stream?.getTracks().forEach((t) => t.stop());
      voiceNoteState.stream = null;
      const blob = new Blob(voiceNoteState.chunks, { type: mr.mimeType || "audio/webm" });
      voiceNoteState.chunks = [];
      voiceNoteState.mediaRecorder = null;
      if (!blob.size) {
        setVoiceNoteStatus("No audio captured. Try again or upload a file.", true);
        els.recordBtn.disabled = false;
        return;
      }
      const ext = blob.type.includes("webm") ? "webm"
        : blob.type.includes("mp4")  ? "mp4"
        : blob.type.includes("ogg")  ? "ogg"
        : "audio";
      await uploadVoiceNoteAudio(blob, `note.${ext}`);
    },
    { once: true }
  );
  mr.stop();
}

// Wire up the modal once. `onConfirmed({ entityType, entityId, summary })` is called
// after a successful save so the host page can refresh whatever view is open.
export function bindVoiceNoteModal({ onConfirmed } = {}) {
  if (voiceNoteState.initBound) return;
  const els = getVoiceNoteEls();
  if (!els) return;
  voiceNoteState.initBound = true;
  els.root.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-voice-note-close]")) closeVoiceNoteModal();
    const langBtn = event.target?.closest?.(".vn-lang-btn");
    if (langBtn) {
      voiceNoteState.outputLang = langBtn.dataset.lang || "TH";
      els.root.querySelectorAll(".vn-lang-btn").forEach(b => b.classList.toggle("vn-lang-btn--active", b === langBtn));
    }
  });
  els.recordBtn.addEventListener("click", () => {
    void startVoiceNoteRecording();
  });
  els.stopBtn.addEventListener("click", () => {
    stopVoiceNoteRecording();
  });
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files?.[0];
    if (!file) return;
    void uploadVoiceNoteAudio(file, file.name);
    els.fileInput.value = "";
  });
  els.confirmBtn.addEventListener("click", async () => {
    if (!voiceNoteState.jobId) return;
    setVoiceNoteStatus("Saving…");
    els.confirmBtn.disabled = true;
    try {
      await api(`/voice-notes/${voiceNoteState.jobId}/confirm`, {
        method: "POST",
        body: {
          transcriptText: els.transcript.value,
          summaryText: els.summary.value
        }
      });
      const reloadAs   = voiceNoteState.entityType;
      const reloadId   = voiceNoteState.entityId;
      const savedSummary = els.summary.value.trim();
      setStatus("Voice note confirmed and saved.");
      closeVoiceNoteModal();
      if (onConfirmed) {
        await onConfirmed({ entityType: reloadAs, entityId: reloadId, summary: savedSummary });
      }
    } catch (error) {
      setVoiceNoteStatus(error.message, true);
      els.confirmBtn.disabled = false;
    }
  });
}
