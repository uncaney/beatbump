import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = """
## 2026-10-01 (heure box ~11:05 UTC) — cycle 21b en prod (integration b3b9db8) : reprise d un appareil a l autre
- Reprise multi-appareil : chaque appareil envoie sa file, sa position et son nom toutes les 15 s pendant la lecture, a la pause et quand la page est masquee (profils connectes uniquement, jamais hors connexion) ; a l ouverture, si un autre appareil a joue plus recemment (plus de 2 min), l accueil propose "Reprendre depuis <appareil> : <titre> a m:ss" ; un clic restaure la file en pause a cette position, rien ne demarre tout seul.
- API : PUT / GET /api/v1/me/nowplaying (une ligne par profil, 64 Ko max, les lectures du harness ignorees comme l historique).
- Harness : coeur 36 etapes (contrat nowplaying).
"""
if "cycle 21b en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 11:05 UTC (heure box) : chaine 21a (b3b9db8) coeur 36/36 (nowplaying_contract PASSE), hors-ligne 15/15 ; promu.\n"
if "chaine 21a (b3b9db8)" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 21b ok")
