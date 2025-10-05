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
  return fetch(path, {cache: "no-store"}).then(async r => {
    if(!r.ok){ throw new Error(`Fetch failed ${r.status} on ${path}`); }
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
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

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
    const ok = (stuSetting === uniSetting
