import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "0b97c13"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box ~13:00 UTC) — cycle 23 en prod (integration {head}) : audit logique v6
- Reprise multi-appareil : la file envoyee au serveur ne contient plus les URL propres a l appareil ; une file locale restauree ne charge rien avant la premiere lecture ; la carte "Reprendre depuis" attend la restauration en cours, restaure une seule fois (message clair en cas d echec), n apparait qu a l arret et se souvient de ce qui a deja ete repris par appareil ; l envoi au serveur n a lieu qu au changement de file ou apres 10 s de lecture.
- Hors-ligne : un epinglage n est jamais perdu lors d un re-telechargement ; un epinglage direct est refuse au-dela du quota au lieu d evincer d autres morceaux ; quand le cache evince des morceaux, tous les onglets le savent immediatement (pastilles et page Hors-ligne a jour).
- Lire tout : le contexte (Playlist, Artiste) vient de la page elle-meme.
- Recherche : plus de squelettes "Tendances" qui clignotent sur un profil avec historique.
- Harness : coeur 38 etapes (historique par jour, reprise multi-appareil entre deux contextes du meme profil) ; staging compte les ecoutes du harness dans les stats pour ces tests.
"""
if "cycle 23 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- 13:00 UTC (heure box) : chaine 23b ({head}) verte ; promu (cycle 23 : c23a + c23b).\n"
if f"chaine 23b ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 23 ok")
