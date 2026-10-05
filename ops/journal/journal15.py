import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = """
## 2026-10-01 08:40 UTC — cycle 15 en prod (integration 6db83db) : lecteur, file, recherche
- File d attente : poignee de glisser et menu visibles sans survol (tactile et clavier), libelle "En cours" sur la ligne jouee ; le tiroir mobile ferme ne montre que la poignee et le compteur, "Vider la file" passe dans l en-tete du tiroir ouvert.
- Plein ecran desktop : pochette jusqu a 360 px avec titre, artiste (lien) et coeur sous la pochette. Mobile : ligne "Suivant : titre · artiste" sous les commandes. Onglet Related : cartes 160 px, trois entieres dans le panneau.
- Recherche : sur un profil neuf, la boite vide propose "Tendances" (6 titres) ; champ pleine largeur sur telephone ; recherches recentes (5 dernieres, bouton Effacer) sous "Reprendre".
- Album : titres des pistes alignes a gauche sur telephone (les pistes YouTube n ont pas de vignette, la cellule d index decalait le texte).
- Harness : coeur 27 etapes (search_empty_state : Tendances puis recherche recente).
"""
if "cycle 15 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 08:40 UTC : chaine 15c (6db83db) coeur 27/27, hors-ligne 11/11 ; promu.\n"
if "chaine 15c (6db83db)" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 15 ok")
