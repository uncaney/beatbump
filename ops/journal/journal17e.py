import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = """
## 2026-10-01 08:50 UTC (heure box) — cycle 17b en prod (integration 3a1bcea) : page Hors-ligne
- Carte album Hors-ligne : deux actions visibles (lire, epingler) et un menu ⋮ (lecture aleatoire, afficher / masquer les pistes) ; plus de chevron.
- Vue Artistes : un seul en-tete par artiste (album ou nombre d albums · N pistes · taille, lire, aleatoire) et les pistes dessous, regroupees par album sans boutons repetes.
- Compteur de la page sur une ligne avec des separateurs " · " ; onglet actif (Up Next / Related) visible dans le panneau desktop du plein ecran.
"""
if "cycle 17b en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 08:50 UTC (heure box) : chaine 17b (3a1bcea) coeur 28/28, hors-ligne 12/12 ; promu.\n"
if "chaine 17b (3a1bcea)" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 17e ok")
