import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box) — cycle 28 en prod (integration {head}) : brainstorm v3
- Accueil instantane : les rangees personnelles sont peintes depuis un cache local puis rafraichies ; prechargement des pages album / artiste / playlist au toucher ou au survol ; rangee "Jamais ecoute" (albums jamais joues) ; carte "Ta semaine" le lundi (minutes, artiste, nouveautes).
- Bibliotheque : genres jouables (Lire / Aleatoire) ; bouton Radio cible sur un album, un artiste ou les favoris ; recherche "bibliotheque" paginee au-dela de 12 resultats ; page playlist serveur complete (retrait d une piste, compteur).
- Hors-ligne : etat de preparation par album ("9/12 prets") avec bouton "Completer" ; invitation d installation de l application au bon moment (apres un premier "Garder hors-ligne" ou a la 3e visite), reportable.
- Accessibilite et premiere visite : annonce vocale du changement de piste pour les lecteurs d ecran ; accueil guide pour un profil sans historique (trois actions).
"""
if "cycle 28 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- (heure box) : chaine 28 ({head}) verte ; promu (cycle 28 : c28b + c28c + c28d).\n"
if f"chaine 28 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 28 ok")
