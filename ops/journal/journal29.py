import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box) — cycle 29 en prod (integration {head}) : brainstorm v3, suite
- Decouverte : mixes par decennie et par genre tires de ta bibliotheque (page Mixes, 40 titres echantillonnes) ; rangee "Redecouvrir" (titres beaucoup ecoutes il y a plus de 60 jours, oublies depuis 30) ; section "Dans ta bibliotheque" sur Explore ; rangee "Nouveautes de tes artistes" (albums ajoutes ces 30 derniers jours d artistes suivis ou tres ecoutes, sans acquisition).
- Hors-ligne : "Liberer 500 Mo" (retire d abord les ecoutes de passage les plus anciennes, jamais les titres epingles, avec apercu avant confirmation) ; "Preparer un pack" de 100 / 250 / 500 Mo (favoris puis ecoutes recentes puis mix), annulable en moins d une seconde ; partage d un lien YouTube vers l application depuis Android (share_target).
- Bibliotheque : tri et filtre memorises par page ; index A-Z sur mobile (albums, artistes) ; export CSV de l historique d ecoute ; page "A propos / Etat" (compteurs, version servie, etat du service worker et du stockage, lien de signalement).
- Correctif de confidentialite (audit logique v8, P1) : la "Radio" des favoris n est plus servie depuis le cache partage (un profil pouvait recevoir pendant 5 minutes la radio des favoris d un autre profil) ; le cache d accueil instantane est vide au changement de profil.
- Robustesse : remontee des erreurs client vers le serveur (anneau de 500, sans donnees de profil) ; vignettes cassees ne provoquent plus d erreur de page ; session de groupe re-initialisable apres deconnexion ; retrait de la ligne en cours en pause reste en pause ; la saisie de recherche ne relance plus la suggestion sur les fleches.
"""
if "cycle 29 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- (heure box) : chaine 29 ({head}) verte ; promu (cycle 29 : fix decode + c29b + c29c + c29d).\n"
if f"chaine 29 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 29 ok")
