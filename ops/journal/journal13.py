import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = """
## 2026-10-01 07:20 UTC — cycle 13 en prod (integration 70fba14) : constats de l audit logique v3
- File d attente : le glisser-deposer passe par le store (le morceau "suivant" est bien le nouveau voisin, URL prechargee rafraichie) ; retirer la ligne en cours lance la ligne qui prend sa place ; "Lire ensuite" sur un titre deja present avec Dedupe actif previent ("Deja dans la file") au lieu de ne rien faire ; "Suivant" sans URL chaude n appelle plus next.json ; "Lire ensuite" sur un titre simple n appelle plus get_queue ; vignettes du lecteur sans mutation partagee.
- Lecteur : la relance sur erreur media purge l entree du service worker et recharge une source fraiche (plus de relecture du meme fichier corrompu), avec une fenetre de 10 min par morceau ; la minuterie de sommeil fond le volume sans ecrire le reglage a chaque pas.
- Hors-ligne : l epingle survit a un re-cache ; epingler un morceau non telecharge le telecharge d abord ; refus propre au-dela du quota ("Quota atteint, augmente-le dans Reglages") ; etat "A retelecharger" pour les entrees evincees avec bouton par ligne et global ; le morceau en cours reste protege de l eviction apres redemarrage du service worker ; les reponses /api/v1/me/* ne sont plus mises en cache par le SW (profils) ; retirer un morceau epingle demande confirmation.
- Divers : suggestions YouTube sans reponse perimee (garde de sequence + abort) ; "Reprendre" ne retombe plus sur la file courante sans historique ; tri inconnu sur local/* -> 400 JSON ; categorie Explorer inconnue -> 404 JSON et page "Categorie introuvable" avec retour ; stats : donnees du dernier passage (deterministe) ; pochettes d albums paginees au-dela de 1000 par artiste ; "Delete All Playlists" avec confirmation ; reglage mort "Playback Updates URL" retire.
- Serveur : les URL inconnues renvoient un vrai statut 404 (la page d erreur de l app reste affichee) ; audio et API intacts.
- Harness : coeur 25 etapes (not_found_status, explore_unknown_category) ; vitest 61 ; captures prod 58 ecrans (audit UX v4 en cours).
"""
if "cycle 13 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 07:00-07:20 UTC : cycle 13 (c13a file/lecteur 7 commits, c13b hors-ligne/SW 6 commits, c13c divers 9 commits) + 404 reel par Opus (premiere version attrapee par le check staging : audio en 404, corrigee c5d4506) fusionne 70fba14 ; staging coeur 25/25 (2 etapes ajoutees ; explore_unknown_category : networkidle ne vient jamais pendant une lecture -> domcontentloaded ; le testid n englobe pas le titre), hors-ligne 11/11 ; promu 07:20 (tarball beatbump-prod-20261001-072043). Captures prod 20261001T070232Z-prod ; audit UX v4 lance 07:05.\n"
if "cycle 13 (c13a" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 13 ok")
