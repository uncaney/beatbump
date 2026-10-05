import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "440861c"
with_c24a = len(sys.argv) > 2 and sys.argv[2] == "c24a"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box ~13:50 UTC) — cycle 24 en prod (integration {head}) : audit UX v7
- Page album : "Garder hors-ligne" sur sa propre ligne d actions sous Play Album / Album Radio, aligne a la gouttiere sur telephone ; duree et annee justes pour les albums YouTube (le serveur inversait les deux champs : lecture par forme, "Album · 13 titres · 2013 · 1 h 14 min").
- Artiste local sans image : en-tete compact avec initiales, pas de bande vide ni de texte alternatif affiche ; note "Artiste de ta bibliotheque" a la place de Radio / Suivre.
- Finitions : titres longs en ellipse, gouttiere de l historique sur telephone, unites Mo / Go dans Reglages, aide sous "Remember Last Track", barre de recherche mobile opaque.
"""
if with_c24a:
    entry += """- Boutons du cycle 18 ("Garder hors-ligne", "Lire tout", "Aleatoire", "Reprendre la file", artiste du plein ecran desktop) : libres de la regle de bouton globale (couleur, capitales, 44 px sur telephone) ; ligne de contexte lisible (12 px minimum) ; bouton "Reprendre la file" rattache a la rangee Reprendre ; cartes Related a 160 px reels ; carte "Reprendre depuis <appareil>" distincte ; plus de "•" orphelin.
"""
if "cycle 24 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- 13:50 UTC (heure box) : chaine 24 ({head}) verte ; promu (cycle 24 : c24b{' + c24a' if with_c24a else ''}).\n"
if f"chaine 24 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 24 ok")
