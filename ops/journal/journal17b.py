import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = """
## 2026-10-01 09:35 UTC — cycles 16 et 17 en prod (integration ab7244c) : audit logique v4 + audit UX v5
- Lecteur : la relance apres erreur media ne supprime plus la copie hors-ligne ni un morceau epingle (1er essai = simple rechargement ; purge seulement au 2e essai, en ligne, hors epingle et hors /localf) ; Dedupe Automix s applique vraiment (file initiale et continuation, curseur conserve) ; un glisser pendant que la file change est rejoue sur la file a jour au lieu de l ecraser ; chaque boucle en mode "repeter un morceau" compte comme une ecoute.
- Plein ecran : cause reelle de l ecran qui restait peint sur Paroles corrigee (deux minuteurs non annules dans le layout) ; le lien artiste de la mini-barre ne bascule plus le plein ecran.
- Hors-ligne : les pages Saved / Playlists / Recents / Pour toi / Compte expliquent qu elles ont besoin du serveur (lien vers Hors-ligne) ; Saved montre la copie locale des favoris ; Reglages > Hors-ligne affiche "dont X epingles" et refuse une limite inferieure ; epinglage d album en un seul bilan, arret au quota ; "Reprendre" de l accueil propose les morceaux en cache hors-ligne ; "Retelecharger" desactive sans reseau.
- Pages artiste / album : identifiant inconnu = 404, erreur amont = message francais explicite ; en-tete d album avec tous les artistes, icone explicite seulement si explicite, repli "Album · N titres · annee".
- Accueil : "Pour toi" sur un profil neuf echantillonne 17 albums au lieu de 3-4.
- Recherche : re-focus d une boite pleine = suggestions pour ce texte.
- Tactile / a11y : zone de tap reelle des liens artiste (26 px, overflow clip), cibles 44 px restantes (chips de recherche, Play Album, Album Radio, Play Radio, Shuffle, Follow), petites capitales de "Voir tout" / "See All" / "Show more" en 13 px, badge lecture uniforme 36 px, chips bibliotheque centrees avec fondu, titre d onglet "Paroles · titre", fond sous le kebab des cartes.
- Serveur : test Go qui verifie la liste des racines SPA contre les routes SvelteKit.
- Harness : coeur 28 etapes, hors-ligne 12 (me_pages_offline_message en cours de mise au point : setOffline de Playwright n atteint pas les fetch du service worker).
"""
if "cycles 16 et 17 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 09:30-09:35 UTC : chaine 17a (ab7244c) coeur 28/28, hors-ligne 11/12 (seul KO = me_pages_offline_message, limite du harness : sans SW le chunk de route ne charge pas hors-ligne, avec SW setOffline ne coupe pas ses fetch ; v3 de l etape = stub de fetch me/* dans la page). Promu ab7244c (cycles 16 + 17).\n"
if "chaine 17a (ab7244c)" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 17b ok")
