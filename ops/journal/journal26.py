import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box) — cycle 26 en prod (integration {head}) : audit UX v8
- Boutons : l echappement de la regle de bouton globale est pose dans la feuille reellement chargee ; "Aleatoire", "Garder hors-ligne", "Rejouer cette journee", "Voir les N titres" et l artiste du plein ecran sont lisibles ; un seul systeme de boutons (plein blanc / translucide / texte), le vert reserve aux etats.
- Listes : plus de separateur orphelin dans la file et l historique ; ellipse des titres longs sur les lignes ; sur desktop, lignes plafonnees avec le kebab a position fixe et grille d albums sur 3 colonnes.
- Accueil : la pilule "Reprendre la file" disparait quand la file est deja chargee.
- Artiste local : l en-tete compact ne passe plus sous la barre fixe ; vignettes cassees remplacees par les initiales.
- Lecteur : planchers typographiques (temps 11 px, contexte 12 px) ; cartes Related a 160 px reels.
- Reglages et Compte : unites coherentes (Mo / Go), page Compte dans le conteneur commun avec "Ton mois" sous le titre.
- Finitions : barre de recherche mobile opaque sous le bouton Fermer, doublons de resultats supprimes, "Most played" masque sous 3 ecoutes, "Delete All Playlists" masque sans playlist, page d erreur en francais.
- Harness : coeur 42 etapes (lisibilite des boutons).
"""
if "cycle 26 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- (heure box) : chaine 26 ({head}) verte ; promu (cycle 26 : c26a + c26b).\n"
if f"chaine 26 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 26 ok")
