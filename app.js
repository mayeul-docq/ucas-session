// ====== VERSION CACHE-BUSTER ======
const V = (window.APP_VERSION || Date.now());

// ====== CONFIG SCORING ======
const ALPHA = {
  country_match:            0.20,
  language_match:           0.20,
  campus_setting_match:     0.20,
  major_match:              0.20,
  application_system_match: 0.10,
  accreditation_match:      0.10
};

const DEFAULTS = {
  desired_majors: ["architecture"],
  desired_accreditations: ["RIBA","ARB"],
  desired_application_system: null
};

// ====== OUTILS ======
const $ = sel => document.querySelector(sel);
function asArray(x){ if (!x) return []; return Array.isArray(x) ? x : [x]; }
function snake(s){ return (s||"").toString().trim().toLowerCase().replace(/[^\w]+/g,"_"); }
function intersect(a, b){
  const A = new Set(asArray(a).map(s=>snake(s)));
  const B = new Set(asArray(b).map(s=>snake(s)));
  for (const v of A){ if (B.has(v)) return true; }
  return false;
}
function loadJson(path){
  // Ajoute ?v=... pour casser le cache sur Pages/clients
  const url = path.includes("?") ? `${path}&v=${V}` : `${path}?v=${V}`;
  return fetch(url, {cache: "no-store"}).then(async r => {
    if(!r.ok){ throw new Error(`Fetch failed ${r.status} on ${url}`); }
    return r.json();
  });
}
function storeToList(maybeStore){
  if (Array.isArray(maybeStore)) return maybeStore;
  const out = [];
  for (const [id, entry] of Object.entries(maybeStore||{})){
    const obj = entry && entry.normalized ? entry.normalized : entry;
    if (obj && typeof obj === "object"){
      if (!obj.id) obj.id = id;
      out.push(obj);
    }
  }
  return out;
}
function findById(list, id){ return list.find(x => (x.id||"") === id); }
function badgeClass(v){ if (v >= 0.8) return "score ok"; if (v >= 0.6) return "score warn"; return "score bad"; }

// ====== SCORING ======
function computeCompatibility(student, uni){
  let scoreSum = 0.0; let weightSum = 0.0; const usedFeatures = [];

  // country_match
  const stuTargets = asArray(student?.preferences?.countries_targets);
  const uniCountry = uni?.country;
  if (uniCountry && stuTargets.length){
    const ok = stuTargets.map(snake).includes(snake(uniCountry));
    if (ok){ scoreSum += ALPHA.country_match; usedFeatures.push("country_match"); }
    weightSum += ALPHA.country_match;
  }

  // language_match
  const stuLangs = asArray(student?.languages);
  const uniLangs = asArray(uni?.offer?.teaching_languages);
  if (stuLangs.length && uniLangs.length){
    const ok = intersect(stuLangs, uniLangs);
    if (ok){ scoreSum += ALPHA.language_match; usedFeatures.push("language_match"); }
    weightSum += ALPHA.language_match;
  }

  // campus_setting_match
  const stuSetting = snake(student?.preferences?.campus_setting);
  const uniSetting = snake(uni?.campus?.setting);
  if (stuSetting && uniSetting){
    const ok = (stuSetting === uniSetting);
    if (ok){ scoreSum += ALPHA.campus_setting_match; usedFeatures.push("campus_setting_match"); }
    weightSum += ALPHA.campus_setting_match;
  }

  // major_match
  const desiredMajors = (asArray(student?.preferences?.domains_priorities).length
    ? asArray(student?.preferences?.domains_priorities) : DEFAULTS.desired_majors);
  const uniMajors = asArray(uni?.offer?.majors);
  if (desiredMajors.length && uniMajors.length){
    const ok = intersect(desiredMajors, uniMajors);
    if (ok){ scoreSum += ALPHA.major_match; usedFeatures.push("major_match"); }
    weightSum += ALPHA.major_match;
  }

  // application_system_match (si désir explicite)
  const desiredApp = DEFAULTS.desired_application_system;
  const uniApp = uni?.admissions?.application_system || null;
  if (desiredApp && uniApp){
    const ok = (snake(desiredApp) === snake(uniApp));
    if (ok){ scoreSum += ALPHA.application_system_match; usedFeatures.push("application_system_match"); }
    weightSum += ALPHA.application_system_match;
  }

  // accreditation_match
  const desiredAcc = asArray(DEFAULTS.desired_accreditations);
  const uniAcc = asArray(uni?.offer?.accreditations);
  if (desiredAcc.length && uniAcc.length){
    const ok = intersect(desiredAcc, uniAcc);
    if (ok){ scoreSum += ALPHA.accreditation_match; usedFeatures.push("accreditation_match"); }
    weightSum += ALPHA.accreditation_match;
  }

  const score = weightSum > 0 ? (scoreSum / weightSum) : 0.0;
  return { score, usedFeatures };
}

// ====== ÉTAT GLOBAL ======
const elStatus = $("#status");
const elResults = $("#results");
const elAlphaView = $("#alphaView");
const elBody = $("#rankingBody");

let SESSION = {
  studentId: null,
  apiKey: null,
  studentNorm: null,
  universities: [],
  scored: []
};

function showAlpha(){ elAlphaView.textContent = JSON.stringify(ALPHA, null, 2); }

function recomputeAndRender(){
  if(!SESSION.studentNorm || !SESSION.universities.length) return;
  const scored = SESSION.universities.map(u => {
    const { score, usedFeatures } = computeCompatibility(SESSION.studentNorm, u);
    return { uni_id: u.id, score, used: usedFeatures };
  }).sort((a,b) => b.score - a.score);
  SESSION.scored = scored;

  elBody.innerHTML = "";
  scored.forEach((r, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>${r.uni_id}</td>
      <td class="${badgeClass(r.score)}">${r.score.toFixed(3)}</td>
      <td><code>${r.used.join(", ") || "—"}</code></td>
    `;
    elBody.appendChild(tr);
  });
  elResults.classList.remove("hidden");
}

// ====== DÉMARRAGE ======
document.getElementById("startBtn").addEventListener("click", start);

async function start(){
  const studentId = $("#studentId").value.trim();
  const apiKey = $("#apiKey").value.trim(); // utilisé pour le chat LLM uniquement
  if (!studentId){ elStatus.textContent = "Merci de saisir un ID élève."; return; }

  SESSION.studentId = studentId;
  SESSION.apiKey = apiKey || "";
  sessionStorage.setItem("OPENAI_API_KEY", SESSION.apiKey);

  elStatus.textContent = "Chargement des données...";
  try{
    const [studentsRaw, studentsNormStore, unisNormStore] = await Promise.all([
      loadJson("./data/students.json"),
      // Fallbacks si tu as d’autres noms en prod
      loadJson("./normalized/normalized_students.json").catch(()=> loadJson("./normalized/students_normalized.json")),
      loadJson("./normalized/normalized_universities.json").catch(()=> loadJson("./normalized/universities_normalized.json"))
    ]);

    const studentsNorm = storeToList(studentsNormStore);
    const unisNorm = storeToList(unisNormStore);

    const student = findById(studentsNorm, studentId);
    if (!student){
      elStatus.innerHTML = `Élève <code>${studentId}</code> non trouvé dans le fichier normalisé.`;
      elResults.classList.add("hidden"); return;
    }

    SESSION.studentNorm = JSON.parse(JSON.stringify(student)); // clone (mutable)
    SESSION.universities = unisNorm;

    showAlpha();
    recomputeAndRender();
    elStatus.textContent = `Classement calculé pour l'élève ${studentId}. Tu peux affiner via le chat bas de page.`;

    appendMsg("info", "Assistant prêt. Décrivez votre profil (préférences, budget, langues, etc.). Je mettrai à jour le profil et recalculerai le classement.");
  } catch(err){
    console.error(err);
    elStatus.textContent = "Erreur de chargement. Vérifie que les fichiers JSON sont présents aux bons emplacements.";
    elResults.classList.add("hidden");
  }
}

// ====== CHAT LLM (mise à jour du profil + recalcul) ======
const chatLog = $("#chatLog");
const chatInput = $("#chatInput");
const chatSend = $("#chatSend");

chatSend.addEventListener("click", onChatSend);
chatInput.addEventListener("keydown", (e)=>{ if(e.key==="Enter" && (e.ctrlKey||e.metaKey)) onChatSend(); });

function appendMsg(role, text){
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

async function onChatSend(){
  const msg = chatInput.value.trim();
  if(!msg){ return; }
  if(!SESSION.studentNorm){ appendMsg("info","Commence par charger un élève (bouton « Commencer »)."); return; }
  appendMsg("user", msg);
  chatInput.value = "";

  const key = SESSION.apiKey || sessionStorage.getItem("OPENAI_API_KEY") || "";
  if(!key){
    appendMsg("assistant", "Aucune clé fournie. Le chat nécessite un token OpenAI (champ en haut).");
    return;
  }

  try{
    const patch = await callOpenAIForPatch(key, msg, SESSION.studentNorm);
    appendMsg("assistant", "Mise à jour proposée :\n" + JSON.stringify(patch, null, 2));
    applyStudentPatch(SESSION.studentNorm, patch);
    recomputeAndRender();
  }catch(err){
    console.error(err);
    appendMsg("assistant", "Erreur lors de l’appel LLM. Vérifiez le token et réessayez.");
  }
}

async function callOpenAIForPatch(apiKey, userMessage, currentStudent){
  const system = `
Tu es un assistant qui met à jour un profil élève normalisé (schéma ci-dessous).
Tu renvoies UNIQUEMENT un JSON avec la clé "patch", dont la valeur est un objet partiel
à fusionner dans le profil existant. N'ajoute AUCUNE autre clé en dehors du "patch".

Schéma élève (extraits utiles) :
{
  "preferences": {
    "campus_setting": "urban"|"suburban"|"rural"|null,
    "values": [string],
    "domains_priorities": [string],
    "countries_targets": [string]
  },
  "constraints": { "pmr": boolean, "visa_flex": boolean },
  "budget": { "annual_total": { "amount": number, "currency": "EUR"|"GBP" } | null },
  "languages": [string],
  "academics": {
    "english": { "evidence": string|null, "score": number|null, "valid_to": string|null }
  }
}
Contraintes:
- Pays en ISO-3166-1 si tu modifies countries_targets ("FR","GB",...).
- Langues en ISO-639-1 ("en","fr",...).
- Ne renvoie que {"patch": { ... }}. Pas de texte libre.
`;

  const payload = {
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: JSON.stringify({
          current_student: currentStudent,
          user_message: userMessage
        }, null, 2)
      }
    ]
  };

  const res = await fetch(`https://api.openai.com/v1/chat/completions?v=${V}`, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
  if(!res.ok){
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  let parsed = {};
  try { parsed = JSON.parse(content); } catch { parsed = {}; }
  return parsed.patch || {};
}

function applyStudentPatch(student, patch){
  function merge(dst, src){
    for(const [k,v] of Object.entries(src||{})){
      if(v && typeof v === "object" && !Array.isArray(v)){
        if(!dst[k] || typeof dst[k] !== "object") dst[k] = {};
        merge(dst[k], v);
      } else {
        dst[k] = v;
      }
    }
  }
  merge(student, patch);
}
