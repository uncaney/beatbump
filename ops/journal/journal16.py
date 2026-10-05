import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 08:10-08:35 UTC : lanes Fable mortes (limite de session, reset 09:30) relancees en modele Opus : la limite est par modele, les deux lanes ont livre. c15a (poignee + kebab au repos, \"En cours\", panneau desktop pochette 360 px + titre/artiste/coeur, tiroir mobile = poignee + compteur et Vider la file dans l en-tete ouvert, ligne \"Suivant :\", cartes Related 160 px ; 5 commits) et c15b (repli Tendances, champ pleine largeur, titres /release alignes a gauche = cellule index sans vignette + space-between, recherches recentes ; 4 commits) fusionnees 6db83db. Chaine 15b (c15a) 26/26 + 11/11 ; chaine 15c (tout) en cours avec l etape search_empty_state (27). Audit logique v4 livre (audit-features-v4.md : 0 P0, 1 P1 H1 = la relance media purge la copie hors-ligne et l epingle, 2 P2 H2 pages me/* hors-ligne, H3 Dedupe inoperant). Cycle 16 lance depuis 6db83db en Opus : c16a H1 H3 H4, c16b H2 G7 H5 H6 H8, c16c H11 H9 H10 G10 H7. Audit UX v5 en cours sur les captures 20261001T075604Z-prod.\n"
if "Cycle 16 lance" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 16 ok")
