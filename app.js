// ====== CONFIG SCORING ======
// Vecteur d'alphas : poids par feature (doit rester lisible et modifiable ici)
const ALPHA = {
  country_match:            0.20,  // le pays de l'université ∈ préférences élève (countries_targets)
  language_match:           0.20,  // intersection entre languages élève et teaching_languages de l'université
  campus_setting_match:     0.20,  // campus.setting == preferences.campus_setting
  major_match:              0.20,  // une major de l'université ∈ domaines visés de l'élève (ou "architecture" par défaut)
  application_system_match: 0.10,  // admissions.application_system == système souhaité (optionnel)
  accreditation_match:      0.10   // université possède au moins une accréditation désirée
};

// Paramètres "désirs" génériques si non spécifiés côté élève
const DEFAULTS = {
  desired_majors: ["architecture"],            // fallback si l'élève n'a pas de domaines_priorities
  desired_accreditations: ["RIBA","ARB"],      // on considère ces accréditations comme souhaitées
  desired_application_system: null             // si null => on ignore cette feature
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

function loadJson(path){ return fetch(path, {cache: "no-store"}).then(r => { if(!r.ok) throw new Error(path); return r.json(); }); }

function storeToList(maybeStore){
  // accepte dict {id: {normalized}} ou liste
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

function findById(list, id){
  return list.find(x => (x.id||"") === id);
}

// ====== SCORING ======
function computeCompatibility(student, uni){
  let scoreSum = 0.0;
  let weightSum = 0.0;
  const usedFeatures = [];

  // country_match : uni.country ∈ student.preferences.countries_targets
  const stuTargets = asArray(student?.preferences?.countries_targets);
  const uniCountry = uni?.country;
  if (uniCountry && stuTargets.length){
    const ok = stuTargets.map(snake).includes(snake(uniCountry));
    if (ok){ scoreSum += ALPHA.country_match; usedFeatures.push("country_match"); }
    weightSum += ALPHA.country_match;
  }

  // language_match : intersection entre student.languages et uni.offer.teaching_languages
  const stuLangs = asArray(student?.languages);
  const uniLangs = asArray(uni?.offer?.teaching_languages);
  if (stuLangs.length && uniLangs.length){
    const ok = intersect(stuLangs, uniLangs);
    if (ok){ scoreSum += ALPHA.language_match; usedFeatures.push("language_match"); }
    weightSum += ALPHA.language_match;
  }

  // campus_setting_match : exact
  const stuSetting = snake(student?.preferences?.campus_setting);
  const uniSetting = snake(uni?.campus?.setting);
  if (stuSetting && uniSetting){
    const ok = (stuSetting === uniSetting);
    if (ok){ scoreSum += ALPHA.campus_setting_match; usedFeatures.push("campus_setting_match"); }
    weightSum += ALPHA.campus_setting_match;
  }

  // major_match : appartenance
  const desiredMajors = (asArray(student?.preferences?.domains_priorities).length
    ? asArray(student?.preferences?.domains_priorities)
    : DEFAULTS.desired_majors);
  const uniMajors = asArray(uni?.offer?.majors);
  if (desiredMajors.length && uniMajors.length){
    const ok = intersect(desiredMajors, uniMajors);
    if (ok){ scoreSum += ALPHA.major_match; usedFeatures.push("major_match"); }
    weightSum += ALPHA.major_match;
  }

  // application_system_match : exact si student en exprime un (sinon ignoré)
  const desiredApp = DEFAULTS.desired_application_system; // changer ici si tu veux forcer "UCAS" par ex.
  const uniApp = uni?.admissions?.application_system || null;
  if (desiredApp && uniApp){
    const ok = (snake(desiredApp) === snake(uniApp));
    if (ok){ scoreSum += ALPHA.application_system_match; usedFeatures.push("application_system_match"); }
    weightSum += ALPHA.application_system_match;
  }

  // accreditation_match : appartient à la liste désirée (si l'université expose ses accréditations)
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

// ====== UI FLOW ======
const elStatus = $("#status");
const elResults = $("#results");
const elAlphaView = $("#alphaView");
const elBody = $("#rankingBody");

function showAlpha(){
  elAlphaView.textContent = JSON.stringify(ALPHA, null, 2);
}

function badgeClass(v){
  if (v >= 0.8) return "score ok";
  if (v >= 0.6) return "score warn";
  return "score bad";
}

async function start(){
  const studentId = $("#studentId").value.trim();
  const apiKey = $("#apiKey").value.trim(); // saisi mais non utilisé ici (conservé pour évolutions futures)
  if (!studentId){
    elStatus.textContent = "Merci de saisir un ID élève."; return;
  }
  sessionStorage.setItem("OPENAI_API_KEY", apiKey || "");

  elStatus.textContent = "Chargement des données...";
  try{
    const [studentsRaw, studentsNormStore, unisNormStore] = await Promise.all([
      loadJson("./data/students.json"),
      loadJson("./normalized/normalized_students.json"),
      loadJson("./normalized/normalized_universities.json")
    ]);

    const studentsNorm = storeToList(studentsNormStore);
    const unisNorm = storeToList(unisNormStore);

    // Cherche l'élève dans normalized ; fallback: affiche warning si non trouvé
    const student = findById(studentsNorm, studentId);
    if (!student){
      elStatus.innerHTML = `Élève <code>${studentId}</code> non trouvé dans <code>normalized_students.json</code>.`;
      elResults.classList.add("hidden");
      return;
    }

    // Calcule scores pour toutes les universités
    const scored = unisNorm.map(u => {
      const { score, usedFeatures } = computeCompatibility(student, u);
      return { uni_id: u.id, score, used: usedFeatures };
    });

    scored.sort((a,b) => b.score - a.score);

    // Affiche
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

    showAlpha();
    elStatus.textContent = `Classement calculé pour l'élève ${studentId}.`;
    elResults.classList.remove("hidden");
  } catch(err){
    console.error(err);
    elStatus.textContent = "Erreur de chargement. Vérifie que les fichiers JSON sont présents aux bons emplacements.";
    elResults.classList.add("hidden");
  }
}

document.getElementById("startBtn").addEventListener("click", start);
