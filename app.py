import os
import json
import shutil
from pathlib import Path
import time
from flask import (
    Flask, render_template, send_file, request, redirect, url_for,
    jsonify, flash, session
)
from flask_wtf import CSRFProtect
from werkzeug.utils import secure_filename
from werkzeug.datastructures import FileStorage

from PyPDF2 import PdfReader, PdfWriter

BASE = Path(__file__).resolve().parent
INPUT_DIR = BASE / "input"
OUTPUT_DIR = BASE / "output"
WORK_DIR = BASE / "work"  # aqui guardamos cópias editáveis e state.json

STATE_FILE = WORK_DIR / "state.json"

ALLOWED_EXTENSIONS = {".pdf"}

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "troque_esta_chave")  # troque em produção
csrf = CSRFProtect(app)


def ensure_dirs():
    for d in (INPUT_DIR, OUTPUT_DIR, WORK_DIR):
        d.mkdir(parents=True, exist_ok=True)


def list_input_pdfs():
    files = [f for f in sorted(INPUT_DIR.iterdir()) if f.suffix.lower() == ".pdf" and f.is_file()]
    return [f.name for f in files]


def safe_state():
    """
    Garante que work/state.json exista e reflita os PDFs atuais.
    State structure:
    {
        "order": ["a.pdf","b.pdf"],
        "files": {
            "a.pdf": {
                "rotations": {"0": 90, "2": 180}  # pagina_index => degrees (0,90,180,270)
            },
            ...
        }
    }
    """
    if not STATE_FILE.exists():
        state = {"order": list_input_pdfs(), "files": {}}
        STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))
        # copiar arquivos originais para work (somente se não existirem)
    else:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        # sincronizar com arquivos de input (adicionar novos, remover ausentes)
        current = list_input_pdfs()
        # adicionar novos
        for f in current:
            if f not in state["order"]:
                state["order"].append(f)
        # remover que sumiram
        state["order"] = [f for f in state["order"] if f in current]
        # clean files keys
        state["files"] = {k: v for k, v in state.get("files", {}).items() if k in state["order"]}
        STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))
    # garantir cópias em work/
    for fname in list_input_pdfs():
        src = INPUT_DIR / fname
        dst = WORK_DIR / fname
        if not dst.exists():
            shutil.copy2(src, dst)
    # remover arquivos work que não existem mais no input
    for p in WORK_DIR.iterdir():
        if p.is_file() and p.name not in list_input_pdfs() and p.name != STATE_FILE.name:
            try:
                p.unlink()
            except Exception:
                pass
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def allowed_filename(name):
    return Path(name).suffix.lower() in ALLOWED_EXTENSIONS



# -- INSIRA logo após as constantes e antes das rotas --
def read_state_file():
    """
    Tenta ler STATE_FILE corretamente:
    1) tentar utf-8
    2) tentar latin-1 (fallback comum no Windows)
    3) se falhar, mover arquivo para backup e retornar estado inicial
    """
    if not STATE_FILE.exists():
        return None

    # 1) tentar utf-8
    try:
        text = STATE_FILE.read_text(encoding="utf-8")
        return json.loads(text)
    except UnicodeDecodeError:
        # 2) tentar latin-1 e regravar em utf-8
        try:
            text = STATE_FILE.read_text(encoding="latin-1")
            state = json.loads(text)
            # reescrever em UTF-8 para corrigir encoding no futuro
            STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
            return state
        except Exception:
            # 3) arquivo inválido / não é JSON — mover para backup e indicar None
            ts = time.strftime("%Y%m%d_%H%M%S")
            backup_name = f"{STATE_FILE.name}.corrupt.{ts}.bak"
            backup_path = STATE_FILE.with_name(backup_name)
            try:
                STATE_FILE.replace(backup_path)
            except Exception:
                # fallback: renomear manualmente
                try:
                    STATE_FILE.rename(backup_path)
                except Exception:
                    pass
            return None
    except json.JSONDecodeError:
        # arquivo UTF-8 mas não é JSON válido -> backup e None
        ts = time.strftime("%Y%m%d_%H%M%S")
        backup_name = f"{STATE_FILE.name}.invalidjson.{ts}.bak"
        backup_path = STATE_FILE.with_name(backup_name)
        try:
            STATE_FILE.replace(backup_path)
        except Exception:
            try:
                STATE_FILE.rename(backup_path)
            except Exception:
                pass
        return None

def save_state(state):
    """
    Salva state em UTF-8 explicitamente.
    """
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")

def safe_state():
    """
    Garantir que work/state.json exista e reflita os PDFs atuais.
    Se o arquivo estiver corrompido, cria um novo e mantém backup.
    """
    # criar pastas se necessário
    ensure_dirs()

    # tentar ler
    state = read_state_file()
    if state is None:
        # criar estado inicial a partir dos arquivos em input/
        state = {"order": list_input_pdfs(), "files": {}}
        save_state(state)

    # sincronizar com arquivos de input (adicionar novos, remover ausentes)
    current = list_input_pdfs()
    # adicionar novos
    for f in current:
        if f not in state["order"]:
            state["order"].append(f)
    # remover que sumiram
    state["order"] = [f for f in state["order"] if f in current]
    # clean files keys
    state["files"] = {k: v for k, v in state.get("files", {}).items() if k in state["order"]}

    save_state(state)

    # garantir cópias em work/ (somente se não existirem)
    for fname in current:
        src = INPUT_DIR / fname
        dst = WORK_DIR / fname
        if not dst.exists():
            try:
                shutil.copy2(src, dst)
            except Exception:
                # se copiar falhar, ignorar e seguir - não deve travar a UI
                pass

    # remover arquivos work que não existem mais no input
    for p in WORK_DIR.iterdir():
        if p.is_file() and p.name not in current and p.name != STATE_FILE.name:
            try:
                p.unlink()
            except Exception:
                pass

    # recarregar e retornar
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


@app.route("/")
def index():
    ensure_dirs()
    state = safe_state()
    return render_template("index.html", state=state)


@app.route("/view/<path:filename>")
def view_pdf(filename):
    # serve a versão no work/ (com rotações aplicadas se houver)
    filename = secure_filename(filename)
    file_path = WORK_DIR / filename
    if not file_path.exists():
        return "Arquivo não encontrado", 404
    # Forçar inline display - send_file com as headers
    return send_file(str(file_path), mimetype="application/pdf", as_attachment=False,
                     download_name=filename)


@app.route("/api/reorder", methods=["POST"])
@csrf.exempt
def api_reorder():
    """
    Recebe JSON: {"order": ["b.pdf","a.pdf", ...]}
    """
    data = request.get_json(force=True)
    if not data or "order" not in data:
        return jsonify({"error": "order faltando"}), 400
    order = [secure_filename(x) for x in data["order"]]
    state = safe_state()
    # validar
    for f in order:
        if f not in state["order"]:
            return jsonify({"error": f"arquivo inválido {f}"}), 400
    state["order"] = order
    save_state(state)
    return jsonify({"status": "ok", "order": state["order"]})


@app.route("/api/delete", methods=["POST"])
@csrf.exempt
def api_delete():
    """
    Recebe JSON: {"filename": "a.pdf"}
    Remove da ordem e remove work copy (mantém original em input)
    """
    data = request.get_json(force=True)
    fname = secure_filename(data.get("filename", ""))
    state = safe_state()
    if fname not in state["order"]:
        return jsonify({"error": "arquivo inválido"}), 400
    state["order"].remove(fname)
    state["files"].pop(fname, None)
    save_state(state)
    work_file = WORK_DIR / fname
    if work_file.exists():
        try:
            work_file.unlink()
        except Exception:
            pass
    return jsonify({"status": "ok", "order": state["order"]})


@app.route("/api/rotate", methods=["POST"])
@csrf.exempt
def api_rotate():
    """
    Rotaciona uma página específica do arquivo no work copy.
    JSON esperado: {"filename":"a.pdf","page":0,"direction":"right"}  # direction: right or left
    Compatível com várias versões do PyPDF2 sem tentar atribuir em reader.pages.
    """
    data = request.get_json(force=True)
    fname = secure_filename(data.get("filename", ""))
    try:
        page_index = int(data.get("page", 0))
    except Exception:
        return jsonify({"error": "page inválida"}), 400
    direction = data.get("direction", "right")
    state = safe_state()
    if fname not in state["order"]:
        return jsonify({"error": "arquivo inválido"}), 400
    work_path = WORK_DIR / fname
    if not work_path.exists():
        return jsonify({"error": "arquivo de trabalho não encontrado"}), 404

    # determinar ângulo (90 para direita, -90 para esquerda)
    angle = 90 if direction == "right" else -90

    def try_rotate_return_new(page_obj, angle_deg):
        """
        Tenta rotacionar a página. Retorna tupla (applied_deg, new_page_or_None).
        Se a API retornar um novo PageObject, devolve-o (não tenta escrever em reader.pages).
        """
        # 1) método moderno: rotate(angle) -> pode retornar novo PageObject ou None
        try:
            if hasattr(page_obj, "rotate"):
                res = page_obj.rotate(angle_deg)
                # se retornar objeto, devolvemos; se não, assumimos modificação in-place
                return (angle_deg % 360, res if res is not None else None)
        except TypeError:
            pass
        except Exception:
            pass

        # 2) métodos antigos (rotate_clockwise / rotateClockwise / rotateCounterClockwise)
        try:
            if angle_deg == 90:
                if hasattr(page_obj, "rotate_clockwise"):
                    page_obj.rotate_clockwise(90); return (90, None)
                if hasattr(page_obj, "rotateClockwise"):
                    page_obj.rotateClockwise(90); return (90, None)
            else:  # -90 -> rotate counterclockwise 90 or clockwise 270
                if hasattr(page_obj, "rotate_counter_clockwise"):
                    page_obj.rotate_counter_clockwise(90); return (270, None)
                if hasattr(page_obj, "rotateCounterClockwise"):
                    page_obj.rotateCounterClockwise(90); return (270, None)
        except Exception:
            pass

        # 3) fallback: manipular o dicionário /Rotate
        try:
            current = 0
            # muitos PageObject suportam .get
            try:
                current = int(page_obj.get("/Rotate", 0) or 0)
                new = (current + angle_deg) % 360
                page_obj["/Rotate"] = new
                return (new, None)
            except Exception:
                # última tentativa via __dict__
                d = getattr(page_obj, "__dict__", None)
                if isinstance(d, dict):
                    cur = int(d.get("/Rotate", 0) or 0)
                    new = (cur + angle_deg) % 360
                    d["/Rotate"] = new
                    return (new, None)
        except Exception:
            pass

        raise RuntimeError("Nenhum método de rotação disponível para este objeto de página.")

    # Ler PDF
    try:
        reader = PdfReader(str(work_path))
    except Exception as e:
        return jsonify({"error": f"falha ao ler PDF: {str(e)}"}), 500

    if page_index < 0 or page_index >= len(reader.pages):
        return jsonify({"error": "index de página inválido"}), 400

    # Aplicar rotação: não tentar escrever em reader.pages; em vez disso, construir writer substituindo a página correspondente
    try:
        # pega o page object original a ser rotacionado
        original_page = reader.pages[page_index]
        applied_deg, new_page_obj = try_rotate_return_new(original_page, angle)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        return jsonify({"error": f"erro ao aplicar rotação: {str(e)}"}), 500

    # Escrever novo PDF: ao iterar pelas páginas do reader, para o índice rotacionado
    writer = PdfWriter()
    try:
        for idx, p in enumerate(reader.pages):
            if idx == page_index:
                if new_page_obj is not None:
                    # se rotacionamos via método que retornou novo objeto, adicioná-lo
                    writer.add_page(new_page_obj)
                else:
                    # caso modificação tenha sido in-place ou /Rotate ajustado, adiciona p
                    writer.add_page(p)
            else:
                writer.add_page(p)
        tmp = WORK_DIR / (fname + ".tmp")
        with open(tmp, "wb") as f:
            writer.write(f)
        tmp.replace(work_path)
    except Exception as e:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        return jsonify({"error": f"falha ao gravar arquivo: {str(e)}"}), 500

    # atualizar state.json (registro acumulado por página)
    files = state.get("files", {})
    info = files.get(fname, {"rotations": {}})
    rotations = info.get("rotations", {})
    prev = int(rotations.get(str(page_index), 0) or 0)
    new_total = (prev + applied_deg) % 360
    rotations[str(page_index)] = new_total
    info["rotations"] = rotations
    files[fname] = info
    state["files"] = files
    save_state(state)

    return jsonify({"status": "ok", "file": fname, "page": page_index, "rotation": new_total})


@app.route("/api/reset/<filename>", methods=["POST"])
@csrf.exempt
def api_reset(filename):
    # restaura work/file para o original do input
    filename = secure_filename(filename)
    state = safe_state()
    if filename not in state["order"]:
        return jsonify({"error": "arquivo inválido"}), 400
    src = INPUT_DIR / filename
    dst = WORK_DIR / filename
    shutil.copy2(src, dst)  # sobrescreve
    state["files"].pop(filename, None)
    save_state(state)
    return jsonify({"status": "ok"})


@app.route("/merge", methods=["POST"])
def merge():
    """
    Unifica usando as cópias em work/ (já contendo rotações individuais aplicadas).
    Gera output/merged.pdf
    """
    ensure_dirs()
    state = safe_state()
    writer = PdfWriter()
    for fname in state["order"]:
        work_file = WORK_DIR / fname
        if not work_file.exists():
            # tentar copiar do input se falta
            src = INPUT_DIR / fname
            if src.exists():
                shutil.copy2(src, work_file)
            else:
                continue
        reader = PdfReader(str(work_file))
        for p in reader.pages:
            writer.add_page(p)
    out_path = OUTPUT_DIR / "merged.pdf"
    with open(out_path, "wb") as f:
        writer.write(f)
    flash(f"Merge concluído: {out_path.name}", "success")
    return redirect(url_for("index"))


@app.route("/download")
def download():
    out_path = OUTPUT_DIR / "merged.pdf"
    if not out_path.exists():
        return "Arquivo não encontrado. Gere o merge primeiro.", 404
    return send_file(str(out_path), as_attachment=True, download_name="merged.pdf")


@app.route("/api/upload", methods=["POST"])
@csrf.exempt
def api_upload():
    """
    Recebe multipart/form-data com 'files' (múltiplos).
    Salva em INPUT_DIR, copia para WORK_DIR, atualiza state e devolve status.
    """
    ensure_dirs()
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "nenhum arquivo enviado"}), 400

    state = safe_state()
    added = []
    for f in files:
        if not isinstance(f, FileStorage):
            continue
        name = secure_filename(f.filename or "")
        if not name or Path(name).suffix.lower() != ".pdf":
            continue
        dest_input = INPUT_DIR / name
        try:
            f.save(str(dest_input))
            # copiar para work se não existir (ou sobrescrever para garantir)
            dst = WORK_DIR / name
            try:
                shutil.copy2(dest_input, dst)
            except Exception:
                try:
                    shutil.copyfile(str(dest_input), str(dst))
                except Exception:
                    pass
            added.append(name)
        except Exception as e:
            # log e continuar
            print("upload save error:", name, e)

    # atualizar state e persistir
    if added:
        # re-ler e sincronizar
        state = safe_state()
        for name in added:
            if name not in state["order"]:
                state["order"].append(name)
        save_state(state)
        return jsonify({"status": "ok", "added": added})
    else:
        return jsonify({"error": "nenhum PDF válido enviado"}), 400


@app.route("/api/delete-all", methods=["POST"])
@csrf.exempt
def api_delete_all():
    """
    Apaga TODOS os PDFs de input/ e work/ e reinicia state.json (nova sessão).
    Use com cautela — ação irreversível.
    """
    ensure_dirs()
    # remover arquivos em input (apenas *.pdf)
    errors = []
    for d in (INPUT_DIR, WORK_DIR):
        for p in list(d.iterdir()):
            try:
                if p.is_file() and p.suffix.lower() == ".pdf":
                    p.unlink()
            except Exception as e:
                errors.append(str(p))
    # reset state
    state = {"order": [], "files": {}}
    save_state(state)
    # garantir work/ limpo (exceto state.json)
    for p in WORK_DIR.iterdir():
        try:
            if p.is_file() and p.name != STATE_FILE.name and p.suffix.lower() == ".pdf":
                p.unlink()
        except Exception:
            pass

    if errors:
        return jsonify({"status": "partial", "errors": errors})
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    ensure_dirs()
    app.run(debug=True, port=5000)
