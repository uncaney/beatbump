import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "892ac9c"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box ~11:40 UTC) — cycle 21 en prod (integration {head}) : audits v5 (P3) et UX v6
- Reprise : l etat de reprise n est ecrit qu au changement (file, curseur, position > 2 s) et une fois a la pause ; ignore apres 30 jours ; purge quand "Remember Last Track" est desactive.
- Contexte de lecture : "File : Suite · n/N" apres une continuation locale ; "Lire tout" / "Aleatoire" posent un contexte (Favoris, Playlist, Artiste) ; une file melant bibliotheque et YouTube garde ses sources (plus de "local" force).
- Historique : horodatage client accepte seulement a 5 min pres de l horloge serveur (rejeu de la file hors-ligne horodate) ; historique par jour sur les 200 dernieres ecoutes (une ligne par ecoute) et "Rejouer cette journee" complet.
- Garder hors-ligne : menu ⋮ dedoublonne ("deja en cours"), annulable depuis le toast, "Indisponible hors connexion" sans reseau ; epinglage piste par piste, re-telechargement si une piste est evincee entre-temps ; les pastilles "Pret hors-ligne" suivent le service worker.
- Artiste local : "Voir les N titres" annonce ce qui est reellement charge (200) avec les pages suivantes exposees par l API.
- File : sur le corps d une ligne, le glisser souris demande 250 ms ET 6 px (plus de glisser accidentel) ; la poignee reste immediate.
- Lecteur : sur telephone, le nom d artiste de la mini-barre est un texte (un tap ouvre le lecteur) ; titre et artiste du plein ecran desktop lisibles sur pochette claire ; "Vider la file" dans le panneau ; chevron de fermeture blanc 44 px.
- Paroles : ligne active lisible (accent sur bande sombre) ; sans paroles, un seul message et pas de barre A-/A+.
- Related "Dans ta bibliotheque" : une carte par album, l artiste courant d abord, cartes 160 px hors de la fleche.
- Pages : kebab visible sur les lignes mobiles aux titres longs ; "Tendances" des l ouverture de la recherche (prechargement + squelettes) avec bouton "Fermer la recherche" 44 px ; boutons des lignes Hors-ligne 44 px ronds ; en-tete d album centre avec annee et duree en francais ; separateurs et espaces corriges (cartes Hors-ligne, "Stockage protege : non · 2 MB utilises sur 11 GB").
"""
if "cycle 21 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- 11:40 UTC (heure box) : chaine 21b ({head}) verte ; promu (cycle 21 : c21a + c21c + c21d).\n"
if f"chaine 21b ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 21c ok")
