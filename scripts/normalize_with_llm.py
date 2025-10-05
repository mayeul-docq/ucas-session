"""
Usage :
  python scripts/normalize_with_llm.py \
    --students ./data/students.json \
    --universities ./data/universities.json \
    --out ./normalized

ENV requis :
  OPENAI_API_KEY
ENV optionnels :
  OPENAI_API_BASE (défaut: https://api.openai.com/v1)
  OPENAI_MODEL (défaut: gpt-4o-mini)
  OPENAI_TEMPERATURE (défaut: 0.1)
  REQUEST_TIMEOUT_SEC (défaut: 60)

Sorties :
  normalized/normalized_students.json         # dict {id: {raw_hash, normalized, meta}}
  normalized/normalized_universities.json     # dict {id: {raw_hash, normalized, meta}}
"""

from __future__ import annotations
import argparse, json, os, sys, time, hashlib, datetime as dt
from typing import Any, Dict, List, Tuple
import requests

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("ERROR: set OPENAI_API_KEY", file=sys.stderr); sys.exit(1)
OPENAI_API_BASE = os.environ.get("OPENAI_API_BASE", "https://api.openai.com/v1").rstrip("/")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_TEMPERATURE = float(os.environ.get("OPENAI_TEMPERATURE", "0.1"))
REQUEST_TIMEOUT_SEC = int(os.environ.get("REQUEST_TIMEOUT_SEC", "60"))

STUDENT_SCHEMA_DOC = """
Tu normalises un objet ELEVE bruité vers ce schéma strict. Réponds UNIQUEMENT en JSON.
{
  "id": string,
  "citizenships": [string],                 // ISO-3166-1 alpha-2
  "residence_country": string|null,         // ISO-3166-1 alpha-2
  "academics": {
    "track": string|null,                   // "bac_general" | "IB" | "a_levels" ...
    "year_level_fr": string|null,           // "terminale" | "premiere" | ...
    "grades": { string: number },
    "english": {
      "evidence": string|null,              // "IELTS" | "TOEFL" | null
      "score": number|null,
      "valid_to": string|null               // "YYYY-MM-DD"
    }
  },
  "preferences": {
    "campus_setting": "urban"|"suburban"|"rural"|null,
    "values": [string],
    "domains_priorities": [string],         // ex: ["architecture","design"]
    "countries_targets": [string]           // ISO-3166-1 alpha-2
  },
  "constraints": {
    "pmr": boolean,
    "visa_flex": boolean
  },
  "budget": {
    "annual_total": { "amount": number, "currency": "EUR"|"GBP" } | null
  },
  "languages": [string]                     // ISO-639-1, ex: "en","fr"
}
Règles: pays ISO-3166-1 ("UK"=> "GB"), langues ISO-639-1, dates "YYYY-MM-DD".
Champs inconnus -> null. Pas d'autre clé ni commentaire.
"""

UNIVERSITY_SCHEMA_DOC = """
Tu normalises un objet UNIVERSITE bruité vers ce schéma strict. Réponds UNIQUEMENT en JSON.
{
  "id": string,
  "country": string|null,                   // ISO-3166-1 alpha-2
  "city": string|null,
  "institution_type": string|null,          // "university" | "school" | ...
  "public_private": string|null,            // "public" | "private" | null
  "offer": {
    "majors": [string],                     // snake_case
    "teaching_languages": [string],         // ISO-639-1
    "duration_years": number|null,
    "student_staff_ratio": number|null,
    "accreditations": [string],             // subset ["RIBA","ARB"]
    "bridge_programs": [string]
  },
  "admissions": {
    "requires_portfolio": boolean,
    "english_min": { "ielts_overall": number|null },
    "application_system": "UCAS"|"direct"|null,
    "deadline": string|null                 // "YYYY-MM-DD"
  },
  "fees": {
    "tuition": { "amount": number, "currency": "GBP"|"EUR" } | null,
    "other_fees": { "amount": number, "currency": "GBP"|"EUR" } | null
  },
  "campus": {
    "setting": "urban"|"suburban"|"rural"|null,
    "pmr_ok": boolean,
    "airports": [string]
  },
  "results": {
    "rank_uk": number|null,
    "salary_median_gbp": number|null
  }
}
Règles: mêmes normalisations que pour l'élève. Inconnu -> null. Pas d'autre clé ni commentaire.
"""

def sha256_obj(o: Any) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(o, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()

def now_iso() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f: return json.load(f)

def dump_json(path: str, data: Any):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f: json.dump(data, f, ensure_ascii=False, indent=2)

def to_store_dict(obj: Any) -> Dict[str, Any]:
    if isinstance(obj, dict): return obj
    if isinstance(obj, list):
        out = {}
        for it in obj:
            _id = (isinstance(it, dict) and it.get("id")) or f"tmp_{len(out)+1}"
            out[_id] = {"raw_hash": None, "normalized": it, "meta": {"migrated_from_list": True}}
        return out
    raise ValueError("Format normalized inconnu (dict ou list attendu).")

def extract_id(entity: Dict[str, Any], kind: str) -> str:
    for k in ["id","student_id","code","uid","slug"]:
        v = entity.get(k)
        if isinstance(v,str) and v.strip(): return v.strip()
    h = hashlib.sha1(json.dumps(entity, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]
    return f"{'stu' if kind=='student' else 'uni'}_{h}"

def openai_chat_json(messages):
    url = f"{OPENAI_API_BASE}/chat/completions"
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}
    payload = {"model": OPENAI_MODEL, "temperature": OPENAI_TEMPERATURE, "response_format":{"type":"json_object"}, "messages": messages}
    backoff = 2.0
    for attempt in range(6):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=REQUEST_TIMEOUT_SEC)
            if r.status_code in (429,) or r.status_code >= 500:
                time.sleep(backoff); backoff = min(backoff*1.6, 20.0); continue
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            return json.loads(content)
        except Exception:
            if attempt == 5: raise
            time.sleep(backoff); backoff = min(backoff*1.6, 20.0)

def normalize_student_llm(raw_student: Dict[str, Any]) -> Dict[str, Any]:
    return openai_chat_json([{"role":"system","content":STUDENT_SCHEMA_DOC},{"role":"user","content":json.dumps({"input_student": raw_student}, ensure_ascii=False)}])

def normalize_university_llm(raw_uni: Dict[str, Any]) -> Dict[str, Any]:
    return openai_chat_json([{"role":"system","content":UNIVERSITY_SCHEMA_DOC},{"role":"user","content":json.dumps({"input_university": raw_uni}, ensure_ascii=False)}])

def process(students_path: str, universities_path: str, out_dir: str) -> Tuple[str, str]:
    raw_students = load_json(students_path)
    raw_unis = load_json(universities_path)
    if not isinstance(raw_students, list): raise ValueError("students.json doit être une liste")
    if not isinstance(raw_unis, list): raise ValueError("universities.json doit être une liste")

    stu_store_path = os.path.join(out_dir, "normalized_students.json")
    uni_store_path = os.path.join(out_dir, "normalized_universities.json")
    stu_store = to_store_dict(load_json(stu_store_path)) if os.path.exists(stu_store_path) else {}
    uni_store = to_store_dict(load_json(uni_store_path)) if os.path.exists(uni_store_path) else {}

    # Students
    up_stu = 0
    for raw in raw_students:
        sid = extract_id(raw, "student")
        rh = sha256_obj(raw)
        entry = stu_store.get(sid)
        if entry and entry.get("raw_hash")==rh and entry.get("normalized"): continue
        norm = normalize_student_llm(raw)
        stu_store[sid] = {"raw_hash": rh, "normalized": norm, "meta": {"updated_at": now_iso(), "model": OPENAI_MODEL}}
        up_stu += 1

    # Universities
    up_uni = 0
    for raw in raw_unis:
        uid = extract_id(raw, "university")
        rh = sha256_obj(raw)
        entry = uni_store.get(uid)
        if entry and entry.get("raw_hash")==rh and entry.get("normalized"): continue
        norm = normalize_university_llm(raw)
        uni_store[uid] = {"raw_hash": rh, "normalized": norm, "meta": {"updated_at": now_iso(), "model": OPENAI_MODEL}}
        up_uni += 1

    dump_json(stu_store_path, stu_store)
    dump_json(uni_store_path, uni_store)
    return (f"[students] upserted: {up_stu}, total: {len(stu_store)} -> {stu_store_path}",
            f"[universities] upserted: {up_uni}, total: {len(uni_store)} -> {uni_store_path}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--students", required=True)
    ap.add_argument("--universities", required=True)
    ap.add_argument("--out", default="./normalized")
    args = ap.parse_args()
    msg1, msg2 = process(args.students, args.universities, args.out)
    print(msg1); print(msg2)

if __name__ == "__main__":
    main()
