#!/usr/bin/env python3
"""Gera worker/cloudflare-worker.js (um so ficheiro para colar na Cloudflare).

Junta o extrator partilhado (js/extract-lite.js) com o codigo do Worker
(worker/src/main.js) e confirma que o resultado e ASCII puro (o editor da
Cloudflare estraga acentos se o ficheiro for aberto com a codificacao errada).

Uso:  python3 tools/build_worker.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def to_ascii(text: str) -> str:
    # caracteres nao-ASCII viram escapes \\uXXXX (validos em strings e regex de JS)
    out = []
    for ch in text:
        code = ord(ch)
        if code < 128:
            out.append(ch)
        elif code <= 0xFFFF:
            out.append("\\u%04x" % code)
        else:
            code -= 0x10000
            out.append("\\u%04x\\u%04x" % (0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF)))
    return "".join(out)


def main() -> int:
    lite = (ROOT / "js" / "extract-lite.js").read_text(encoding="utf-8")
    lite = re.sub(r"\nif \(typeof module !== 'undefined'\) module\.exports = LiteX;\s*$", "\n", lite)
    main_src = (ROOT / "worker" / "src" / "main.js").read_text(encoding="utf-8")

    # o comentario de cabecalho do main.js fica no topo do ficheiro final
    m = re.match(r"(/\*[\s\S]*?\*/\s*)", main_src)
    header, rest = (m.group(1), main_src[m.end():]) if m else ("", main_src)
    out = header + "\n" + lite.strip() + "\n\n" + rest
    out = to_ascii(out)

    dest = ROOT / "worker" / "cloudflare-worker.js"
    dest.write_text(out, encoding="ascii")
    print(f"OK: {dest.relative_to(ROOT)} ({len(out.splitlines())} linhas, {len(out)} bytes, ASCII)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
