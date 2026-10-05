#!/usr/bin/env python3
"""Journal d une promotion : entree CHANGELOG.md + ligne CYCLES.md (cycle 34 OP2).

Usage : python3 agents/ops/journal.py <cycle> <head> [--chain <N>] [--dry-run]
  <cycle> : identifiant du cycle (33, 21b, ...) ; le texte vient de agents/ops/journal/cycle-<cycle>.md
  <head>  : SHA court promu (integration), ex. b8e98f4
  --chain : numero de la chaine staging verte, requis si le texte contient {chain}
  --dry-run : affiche ce qui serait ecrit, n ecrit rien

Logique commune reprise des /tmp/journalNN.py (copies dans agents/ops/journal/) :
  - l entree est ajoutee en fin de CHANGELOG.md seulement si son marqueur n est pas deja dans un titre
    "## " de CHANGELOG.md (idempotent) ;
  - la ligne CYCLES.md (meta "cycles:") est ajoutee seulement si son marqueur ("cycles-marker:",
    sinon la ligne entiere) n est pas deja dans une ligne "- " de CYCLES.md.
Garde-fous (cycle 39, L11-14) : <head> doit etre un sha court (^[0-9a-f]{7,12}$) ; "cycles-marker:" est
obligatoire quand "cycles:" contient {now}, {date} ou {time} (sinon une relance ajouterait une 2e ligne) ;
tout jeton {xxx} sans valeur arrete le script AVANT toute ecriture. Relancer le meme cycle / head ne
change rien et le dit ("rien a ecrire"). --dry-run affiche les lignes exactes qui seraient ajoutees.

Format d un fichier cycle-<N>.md (un nouveau cycle = un nouveau fichier texte, pas de code) :
  <!-- marker: cycle 34 en prod -->                       (defaut : "cycle <N> en prod")
  <!-- cycles: - {now} : chaine {chain} ({head}) verte ; promu (cycle 34 : c34a + c34b). -->   (optionnel)
  <!-- cycles-marker: chaine {chain} ({head}) verte -->   (optionnel)
  ## {date} {time} UTC (horloge box) : cycle 34 en prod (integration {head}) : titre
  - puce 1
  - puce 2
Jetons remplaces (remplacement litteral, pas de format Python) : {head}, {chain},
{date} = date -u AAAA-MM-JJ, {time} = HH:MM, {now} = "HH:MM UTC JJ/MM (horloge box)" (convention de
CYCLES.md depuis la correction d horodatage du 01/10 17:21 UTC).
"""
import datetime
import pathlib
import re
import sys

PROGRAM = pathlib.Path("/srv/beatbump/agents/program")
DATA = pathlib.Path(__file__).resolve().parent / "journal"
META_RE = re.compile(r"^<!--\s*([a-z-]+):\s?(.*?)\s*-->\s*$")


def parse(path):
    meta, body = {}, []
    lines = path.read_text().splitlines(keepends=True)
    i = 0
    while i < len(lines):
        m = META_RE.match(lines[i])
        if not m:
            break
        meta[m.group(1)] = m.group(2)
        i += 1
    body = "".join(lines[i:])
    return meta, body


def fill(text, tokens):
    for k, v in tokens.items():
        text = text.replace("{" + k + "}", v)
    left = re.findall(r"\{([a-z][a-z_-]*)\}", text)
    if left:
        sys.exit(f"jeton sans valeur : {{{left[0]}}} (passer --chain ?)")
    return text


def present(path, marker, prefix):
    """Le marqueur est-il deja dans une ligne qui commence par prefix ? Renvoie cette ligne ou None."""
    for l in path.read_text().splitlines():
        if l.startswith(prefix) and marker in l:
            return l
    return None


def append_once(path, marker, block, prefix, dry):
    hit = present(path, marker, prefix)
    if hit is not None:
        print(f"{path.name} : deja present, rien a ecrire ({marker}) : {hit[:160]}")
        return False
    if dry:
        print(f"--- {path.name} : lignes exactes qui seraient ajoutees (dry-run) ---")
        sys.stdout.write(block if block.endswith("\n") else block + "\n")
        print(f"--- fin {path.name} ---")
        return True
    s = path.read_text()
    tmp = path.with_suffix(path.suffix + ".tmp-journal")
    tmp.write_text(s.rstrip("\n") + "\n" + block)
    tmp.replace(path)
    print(f"{path.name} : ajoute ({marker})")
    return True


def main(argv):
    args, dry, chain, it = [], False, None, iter(argv)
    for a in it:
        if a == "--dry-run":
            dry = True
        elif a == "--chain":
            chain = next(it, None)
            if chain is None:
                sys.exit("--chain sans valeur")
        else:
            args.append(a)
    if len(args) != 2:
        sys.exit(__doc__.split("\n\n")[1])
    cycle, head = args
    if not re.fullmatch(r"[0-9a-f]{7,12}", head):
        sys.exit(f"head invalide : {head!r} (attendu un sha court, ^[0-9a-f]{{7,12}}$)")
    if chain is not None and not re.fullmatch(r"[0-9]+[a-z]?", chain):
        sys.exit(f"--chain invalide : {chain!r} (attendu un numero de chaine, ex. 41)")
    src = DATA / f"cycle-{cycle}.md"
    if not src.is_file():
        sys.exit(f"texte absent : {src} (creer ce fichier, voir le format dans journal.py)")
    meta, body = parse(src)
    now = datetime.datetime.now(datetime.timezone.utc)
    tokens = {"head": head, "date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M"),
              "now": now.strftime("%H:%M UTC %d/%m") + " (horloge box)"}
    if chain is not None:
        tokens["chain"] = chain
    marker = fill(meta.get("marker", f"cycle {cycle} en prod"), tokens)
    entry = "\n" + fill(body.strip("\n"), tokens) + "\n"
    if marker not in entry:
        sys.exit(f"le marqueur {marker!r} n apparait pas dans le texte de {src.name}")
    line = cmark = None
    if "cycles" in meta:  # rempli AVANT toute ecriture : un jeton manquant n ecrit rien
        if "cycles-marker" not in meta and re.search(r"\{(now|date|time)\}", meta["cycles"]):
            sys.exit(f"{src.name} : 'cycles-marker:' obligatoire quand 'cycles:' contient {{now}}/{{date}}/{{time}} "
                     "(sinon une relance ajoute une 2e ligne) ; rien n a ete ecrit")
        line = fill(meta["cycles"], tokens)
        cmark = fill(meta.get("cycles-marker", line), tokens)
        if not cmark.strip():
            sys.exit(f"{src.name} : 'cycles-marker:' vide ; rien n a ete ecrit")
    changed = append_once(PROGRAM / "CHANGELOG.md", marker, entry, "## ", dry)
    if line:
        changed = append_once(PROGRAM / "CYCLES.md", cmark, line + "\n", "- ", dry) or changed
    if not changed:
        print(f"journal {cycle} : rien a ecrire, cycle {cycle} deja journalise (CHANGELOG.md et CYCLES.md inchanges)")
    else:
        print(f"journal {cycle} ok" + (" (dry-run : rien ecrit)" if dry else ""))


if __name__ == "__main__":
    main(sys.argv[1:])
