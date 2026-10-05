import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box) — cycle 30 en prod (integration {head}) : brainstorm v4 + audit logique v8
- Accueil : un album n apparait plus que dans une seule rangee (priorite Reprendre, Pour toi, Redecouvrir, Nouveautes, Jamais ecoute, Recemment acquis), au plus 4 rangees personnelles au-dessus des rangees YouTube, le reste derriere "Plus pour toi" ; les trois rangees du cycle 29 sont peintes instantanement depuis le cache local ; "Voir tout" mene a la liste correspondante (filtres Jamais ecoute / Ajoutes ces 30 jours sur les albums, page Redecouvrir) ; premiere visite sans impasse ("Lancer un mix", "Dis-moi ton prenom").
- Bibliotheque et hors-ligne : "Liberer de l espace" et "Preparer un pack" deplaces sur la page Hors-ligne (carte Espace, une seule taille), Reglages = interrupteurs seulement ; navigation bibliotheque ramenee a 9 puces en 3 groupes ; une seule page Favoris ; un seul bouton Radio sur un album local ; un mot par concept (Pour toi, Radio, Mix, Mixtape) ; bouton Mix sur Explore ; cartes "Tes artistes" et "Garder hors-ligne" sur chaque mix ; cartes genre toujours jouables.
- Performance : "Jamais ecoute" calcule depuis l historique (10 fois moins d appels a l index) ; survey des mixes memoise 5 minutes.
- Robustesse et securite : export CSV protege contre l injection de formules (BOM UTF-8) ; journal des erreurs client lisible uniquement avec un jeton, envois limites par adresse ; zones tactiles de 44 px sur les boutons genre / Completer / corbeille / fermer ; index A-Z borne ; version servie affichee sur /about ; feuille de style morte supprimee.
"""
if "cycle 30 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- (heure box) : chaine 31 ({head}) verte ; promu (cycle 30 : c30a + c30b + c30c).\n"
if f"chaine 31 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 30 ok")
