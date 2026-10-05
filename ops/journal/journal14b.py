import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = """
## 2026-10-01 07:50 UTC — cycle 14 en prod (integration 9be934e) : audit UX v4
- Artiste introuvable : un identifiant inconnu donne une vraie reponse 404 JSON cote serveur (avant : panic Go et page "Internal Error") et une page d erreur en francais ("Cet artiste n existe pas ou n est plus disponible") ; messages d erreur par statut, jamais le texte brut de YouTube ; artiste local sans nom ni album -> 404.
- Lecteur : le plein ecran se referme une seconde fois apres la navigation vers Paroles (filet) et la page Paroles le ferme a l ouverture ; lien Paroles de la barre identifiable pour les captures desktop.
- Accueil : "Pour toi" ne repete plus une pochette (1 carte par album, 2 par artiste, puis completion depuis les cartes ecartees).
- Zones tactiles : la racine mobile est a 12 px, donc les minima en rem s effondraient (33 px) ; boutons epingle / retirer / retelecharger 44x36, cartes album 44x44, CTA et vues Hors-ligne 44, reglages Hors-ligne 44 ; liens artiste des sous-titres avec une zone de tap de 26 px ; kebab desktop juste apres le texte.
- Listes : pochettes des 12 premieres lignes chargees en priorite (plus de vignettes vides sur mobile), badge lecture 36 px dans le coin au lieu de 40 px au centre.
- a11y : fleches de carrousel nommees, "Voir tout" 13 px / 28 px, style desactive sur "Delete All Playlists", tiret remplace sur la page Compte.
- Hors-ligne : en-tete sans "En ligne", chips de la bibliotheque sur une rangee sur telephone.
- Harness : coeur 26 etapes (artist_not_found ; controle "plein ecran ferme" durci ; clics sur les lignes au bord gauche car le lien artiste capte desormais le centre de la ligne).
"""
if "cycle 14 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 07:30-07:50 UTC : cycle 14 fusionne 5e90030 (+ Go 9be934e). Chaine 14a (6a04b00) : artist_not_found KO = panic Go parseArtist Tabs[0] sur reponse YouTube vide -> 502 ; correctif Go (404 JSON, garde anti-panic, local inconnu 404). Chaine 14b (5e90030) : 6 KO coeur = le lien artiste du sous-titre a maintenant une zone de tap de 26 px et capte le clic du harness au centre de la ligne \"Song •\" (page artiste au lieu de lecture) -> harness et shots.cjs cliquent au bord gauche. Re-test 9be934e : coeur 26/26, hors-ligne 11/11 ; promu 07:50.\n"
if "cycle 14 fusionne" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 14 ok")
