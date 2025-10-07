// ====== Config & Poids (ALPHA) ======
const ALPHA = {
  country_match:            0.20,
  language_match:           0.20,
  campus_setting_match:     0.20,
  major_match:              0.20,
  application_system_match: 0.10,
  accreditation_match:      0.10,
};

// ====== Helpers version ======
const V = (window.APP_VERSION || "0");
const withV = (url) => url.includes("?") ? `${url}&v=${encodeURIComponent(V)}` : `${url}?v=${encodeURIComponent(V)}`;

// ====== DOM ======
const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const alphaView = $("#alphaView");
const rankingBody = $("#rankingBody");
const resultsSection = $("#results");
const studentIdInput = $("#studentId");
const apiKeyInput = $("#apiKey");
const startBtn = $("#startBtn");
const resetBtn = $("#btnReset");
const chatLog = $("#chatLog");
const chatInput = $("#chatInput");
const chatSend = $("#chatSend");

// ====== State ======
let STORES = {
  studentsNorm: {},        // dict {id: { raw_hash, normalized, meta }}
  universitiesNorm: {},    // dict {id: { raw_hash, normalized, meta }}
};
let currentStudent = null; // objet normalisé (==> STORES.studentsNorm[stuId].normalized)
let apiKey = null;

// ====== UI helpers ======
const setStatus = (msg, kind = "info") => {
  statusEl.classList.remove("hidden");
  statusEl.textContent = msg;
  if (kind === "error") statusEl.style.color = "#b91c1c"; else statusEl.style.color = "";
};

const fmtScoreClass = (s) => (s >= 0.75 ? "ok" : s >= 0.5 ? "warn" : "bad");
const clearRanking = () => (rankingBody.innerHTML = "");

// ====== Fetch JSON avec version & tolérance dict/list ======
async function fetchJson(path) {
  const res = await fetch(withV(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch ${path} -> ${res.status}`);
  return res.json();
}
function toStoreDict(maybe) {
  if (!maybe) return {};
  if (Array.isArray(maybe)) {
    const out = {};
    for (const it of maybe) {
      const id = (it && (it.id || it.student_id || it.code || it.uid || it.slug)) || `tmp_${Object.keys(out).length + 1}`;
      out[id] = { raw_hash: null, normalized: it, meta: { migrated_from_list: true } };
    }
    return out;
  }
  if (typeof maybe === "object") return maybe;
  return {};
}

// ====== Chargement des fichiers normalisés (avec fallback de noms) ======
async function loadStores() {
  setStatus("Chargement des données…");
  // students_normalized.json fallbacks
  let studentsNorm = null;
  try { studentsNorm = await fetchJson("./normalized/normalized_students.json"); }
  catch { try { studentsNorm = await fetchJson("./normalized/students_normalized.json"); } catch (e) { throw new Error("Fichier normalized_students introuvable"); } }

  // universities_normalized.json fallbacks
  let universitiesNorm = null;
  try { universitiesNorm = await fetchJson("./normalized/normalized_universities.json"); }
  catch { try { universitiesNorm = await fetchJson("./normalized/universities_normalized.json"); } catch (e) { throw new Error("Fichier normalized_universities introuvable"); } }

  STORES.studentsNorm = toStoreDict(studentsNorm);
  STORES.universitiesNorm = toStoreDict(universitiesNorm);
}

// ====== Sélection élève ======
function selectStudentById(stuId) {
  const slot = STORES.studentsNorm[stuId];
  if (!slot || !slot.normalized) throw new Error(`Élève ${stuId} introuvable dans le store normalisé.`);
  currentStudent = structuredClone(slot.normalized);
}

// ====== Scoring ======
// Règles helpers
function eq(a, b) { return a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase(); }
function includesAny(arr, x) {
  if (!Array.isArray(arr) || x == null) return false;
  return arr.map(String).map(s => s.toLowerCase()).includes(String(x).toLowerCase());
}
function intersects(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const bs = new Set(b.map(x => String(x).toLowerCase()));
  return a.some(x => bs.has(String(x).toLowerCase()));
}

function computeCompatibility(stu, uni) {
  let num = 0, den = 0;
  const used = []; // trace des features utilisées

  // country_match
  const stuCountries = (stu?.preferences?.countries_targets) || null;
  const uniCountry = (uni?.country) || null;
  if (stuCountries && uniCountry) {
    den += ALPHA.country_match;
    const ok = includesAny(stuCountries, uniCountry);
    if (ok) num += ALPHA.country_match;
    used.push(["country_match", ok]);
  }

  // language_match
  const stuLangs = (stu?.languages) || null;
  const uniLangs = (uni?.offer?.teaching_languages) || null;
  if (stuLangs && uniLangs) {
    den += ALPHA.language_match;
    const ok = intersects(stuLangs, uniLangs);
    if (ok) num += ALPHA.language_match;
    used.push(["language_match", ok]);
  }

  // campus_setting_match
  const stuSetting = (stu?.preferences?.campus_setting) || null;
  const uniSetting = (uni?.campus?.setting) || null;
  if (stuSetting && uniSetting) {
    den += ALPHA.campus_setting_match;
    const ok = eq(stuSetting, uniSetting);
    if (ok) num += ALPHA.campus_setting_match;
    used.push(["campus_setting_match", ok]);
  }

  // major_match
  const stuMajors = (stu?.preferences?.domains_priorities) || null;
  const uniMajors = (uni?.offer?.majors) || null;
  if (stuMajors && uniMajors) {
    den += ALPHA.major_match;
    const ok = intersects(stuMajors, uniMajors);
    if (ok) num += ALPHA.major_match;
    used.push(["major_match", ok]);
  }

  // application_system_match
  const uniSys = (uni?.admissions?.application_system) || null;
  // Heuristique : si le pays ciblé contient GB/IE => UCAS préférable ; sinon direct
  const wantsGB = Array.isArray(stuCountries) && (includesAny(stuCountries, "GB") || includesAny(stuCountries, "UK"));
  if (uniSys && (stuCountries?.length || 0) > 0) {
    den += ALPHA.application_system_match;
    const ok = (wantsGB && uniSys === "UCAS") || (!wantsGB && uniSys !== "UCAS");
    if (ok) num += ALPHA.application_system_match;
    used.push(["application_system_match", ok]);
  }

  // accreditation_match (RIBA/ARB)
  const uniAcc = (uni?.offer?.accreditations) || null;
  if (uniAcc && uniAcc.length > 0 && stuMajors && intersects(stuMajors, ["architecture"])) {
    den += ALPHA.accreditation_match;
    const ok = intersects(uniAcc, ["RIBA","ARB"]);
    if (ok) num += ALPHA.accreditation_match;
    used.push(["accreditation_match", ok]);
  }

  const score = den > 0 ? (num / den) : 0;
  return { score, used };
}

// ====== Rendu du classement ======
function renderAlpha() {
  alphaView.textContent = JSON.stringify(ALPHA, null, 2);
}

function renderRanking(stu) {
  clearRanking();
  const rows = [];

  for (const [uid, entry] of Object.entries(STORES.universitiesNorm)) {
    const uni = entry?.normalized;
    if (!uni) continue;
    const { score, used } = computeCompatibility(stu, uni);
    rows.push({ uid, uni, score, used });
  }

  rows.sort((a, b) => b.score - a.score);

  const frag = document.createDocumentFragment();
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    const cls = fmtScoreClass(r.score);
    const usedTags = r.used.map(([k, ok]) => `${ok ? "✅" : "❌"} ${k}`).join(" · ");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><strong>${r.uni?.name || r.uid}</strong><br><small class="muted">${r.uid}</small></td>
      <td class="score ${cls}">${r.score.toFixed(2)}</td>
      <td>${usedTags}</td>
    `;
    frag.appendChild(tr);
  });
  rankingBody.appendChild(frag);
  resultsSection.classList.remove("hidden");
}

// ====== Chat LLM ======
function appendMsg(kind, text) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.innerHTML = `<div class="bubble">${text}</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function callOpenAIForPatch(userMessage, stuSnapshot) {
  // Token côté client: on l'utilise direct pour /chat/completions
  if (!apiKey) throw new Error("Saisis d'abord ta clé OpenAI pour utiliser le chat.");

  const sys = [
    "Tu es un assistant de profil. Tu renvoies UNIQUEMENT du JSON de la forme: { \"patch\": { ... } }.",
    "Le patch doit correspondre au schéma étudiant normalisé (langues ISO-639-1, pays ISO-3166-1, etc.).",
    "Aucune prose. Aucun commentaire. Un seul objet JSON racine.",
  ].join(" ");

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify({ current_student: stuSnapshot, user_message: userMessage }) },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error("Réponse LLM invalide (pas du JSON)."); }
  if (!parsed || typeof parsed !== "object" || !parsed.patch || typeof parsed.patch !== "object") {
    throw new Error("Format attendu { \"patch\": { ... } } manquant.");
  }
  return parsed.patch;
}

// Merge superficiel (shallow) : uniquement les clés de premier niveau
function applyPatchShallow(obj, patch) {
  const out = { ...obj };
  for (const [k, v] of Object.entries(patch)) out[k] = v;
  return out;
}

// ====== Actions ======
async function onStart() {
  try {
    apiKey = apiKeyInput.value.trim() || null;
    if (apiKey) sessionStorage.setItem("OPENAI_API_KEY", apiKey);
    else sessionStorage.removeItem("OPENAI_API_KEY");

    await loadStores();
    const stuId = (studentIdInput.value || "").trim();
    if (!stuId) throw new Error("Merci de saisir un ID élève.");
    selectStudentById(stuId);
    setStatus(`OK — Élève sélectionné : ${stuId}`);
    renderAlpha();
    renderRanking(currentStudent);
  } catch (e) {
    console.error(e);
    setStatus(`Erreur : ${e.message}`, "error");
  }
}

async function onChatSend() {
  const msg = (chatInput.value || "").trim();
  if (!msg) return;
  appendMsg("user", msg);
  chatInput.value = "";
  try {
    const patch = await callOpenAIForPatch(msg, currentStudent);
    appendMsg("assistant", "Patch reçu :\n" + JSON.stringify(patch, null, 2));
    currentStudent = applyPatchShallow(currentStudent, patch);
    renderRanking(currentStudent);
  } catch (e) {
    appendMsg("info", `⚠️ ${e.message}`);
  }
}

function onReset() {
  try {
    sessionStorage.removeItem("OPENAI_API_KEY");
    studentIdInput.value = "";
    apiKeyInput.value = "";
    currentStudent = null;
    clearRanking();
    resultsSection.classList.add("hidden");
    setStatus("Réinitialisé. Saisis l’ID élève et le token puis clique « Commencer ».");
    chatLog.innerHTML = "";
  } catch {}
}

// ====== Wire-up ======
window.addEventListener("DOMContentLoaded", () => {
  const k = sessionStorage.getItem("OPENAI_API_KEY");
  if (k) apiKeyInput.value = k;
  startBtn.addEventListener("click", onStart);
  chatSend.addEventListener("click", onChatSend);
  resetBtn?.addEventListener("click", onReset);
});
