import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 07:25-07:45 UTC : audit UX v4 livre (audit-ux-v4.md : 2 regressions P2 = artiste inconnu rendu \"Internal Error\", minima tactiles en rem effondres par la racine 12 px ; TOP 10 cycle 14). Cycle 14 lance depuis 70fba14 : c14a lecteur/paroles/artiste et c14c accueil/recherche mortes a la naissance (limite de session API, reset 09:30 UTC) ; c14b zones tactiles/a11y livree (5 commits). Opus solo : artiste introuvable = 404 + message FR par statut dans +error.svelte, filet plein ecran (set closed apres goto, data-state, onMount paroles), data-testid player-lyrics, \"Pour toi\" sans pochette dupliquee (diversify dedup par URL de pochette, 1/album, 2/artiste, second passage). Harness coeur 26 etapes (artist_not_found ; controle plein ecran durci : cible .fullscreen-player-popup et hors ecran ; passe deja sur staging = le P1 de l audit est un artefact des captures shots.cjs). shots.cjs : parcours Paroles desktop via le lien de la barre. Fusion 5e90030, chaines staging 14a (6a04b00) puis 14b (5e90030) en cours.\n"
if "Cycle 14 lance" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 14 ok")
