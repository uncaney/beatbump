import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "a19cace"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box ~10:30 UTC) — cycles 18, 19 et 20 en prod (integration {head}) : continuite, hors-ligne, bibliotheque, file
- Reprise exacte : a la reouverture, la file, la position et le contexte reviennent tels quels, en pause (reglage "Remember Last Track" active par defaut, migre une fois pour les anciens profils, interrupteur retabli dans Reglages > Playback) ; bouton "Reprendre la file" dans l accueil ; raccourci d icone "Reprendre" ; la restauration ne declenche ni acquisition ni mise en cache avant la premiere lecture ; une ecoute restauree n est pas comptee deux fois (comptage sur le temps reellement ecoute).
- Contexte de lecture : "Album : X · 4/14", "Favoris", "File", "Hors-ligne" dans le plein ecran et sous le titre de la mini-barre desktop, lien vers la source, "Revenir a l album" apres un "Lire ensuite".
- Fin de file locale : la lecture continue avec des titres de la bibliotheque lies au dernier morceau (reglage "Continuer apres la fin de la file", pas de suite hors connexion).
- Ecran verrouille / casque : ±10 s, position mise a jour a chaque saut, pochette locale 512 px.
- Garder hors-ligne : bouton sur l album (local et YouTube), la playlist serveur et les Favoris + entree de menu ; telechargement 2 par 2 puis epinglage, progression "9/14 prets", annulation, respect du quota, lot qui survit a la navigation.
- Pastille "Pret hors-ligne" sur les lignes et cartes en cache ; hors connexion, les titres indisponibles sont attenues et expliquent pourquoi.
- Ecoutes hors connexion gardees en file et envoyees au retour du reseau (horodatage client accepte dans les 7 jours, rejeu idempotent).
- Stockage persistant demande au premier epinglage ; Reglages > Hors-ligne affiche "Stockage protege : oui / non" et l usage.
- Bibliotheque : "Lire tout" / "Aleatoire" sur Favoris, playlist serveur et artiste local (tous les titres, "Voir les N titres") ; historique groupe par jour avec "Rejouer cette journee" ; raccourcis d icone (Reprendre, Hors-ligne, Rechercher, Pour toi).
- File d attente : le glisser a la souris fonctionne (poignee immediate, ligne apres un court maintien), Alt+fleches au clavier ; les playlists locales conservent l ordre et la file suit.
- Harness : coeur 35 etapes, hors-ligne 15 (glisser verifie en navigateur, raccourcis, Lire tout, contexte, reprise, Garder hors-ligne, pastilles, stockage).
"""
if "cycles 18, 19 et 20 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
print("changelog 18-20 ok")
