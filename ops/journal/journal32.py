import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-02 (heure box) — cycle 32 en prod (integration {head}) : audit UX v11
- Lecteur : ligne de progression sur la mini-barre mobile ; poignee de file de 48 px sans compteur en double, boutons aleatoire / repetition avec un etat "off" lisible ; le tiroir de file est inerte quand il est ferme (plus de 100 liens invisibles au clavier) ; carte "Reprendre" compacte quand il n y a qu une entree ; invitation d installation en barre compacte accrochee a la mini-barre (Installer / Plus tard 14 jours).
- Lisibilite : les liens habilles en bouton (Explorer, Voir tout) ont leur libelle centre ; page d erreur et page Compte dans le systeme de boutons ; texte secondaire jamais sous 12 px sur mobile ; cibles tactiles de 44 px sur Voir tout, le tri, les cartes hors-ligne et le compte ; reglages mobile : interrupteur sur la ligne de son libelle.
- Coherence : un seul nom pour garder la musique hors-ligne ("Garder hors-ligne", y compris dans le menu du lecteur, "Telecharger sur l appareil" reste le vrai telechargement de fichier) ; icone Mixtape distincte de Radio ; phrase contradictoire supprimee sur les pages d artistes locaux.
"""
if "cycle 32 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- (heure box) : chaine 33 ({head}) verte ; promu (cycle 32 : c32a + c32b).\n"
if f"chaine 33 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 32 ok")
