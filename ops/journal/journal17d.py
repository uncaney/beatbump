import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 08:50 UTC (heure box) : sonde probe-drag.cjs sur staging : le glisser souris des lignes de la file ne reordonne rien (dragTo depuis .drag-handle et sequence pointer synthetique ; dragTo lance meme la ligne cible) -> etape queue_reorder_next parquee, lane c19a-queue-drag (Opus) lancee pour rendre les pointer events autoritaires. Lane c17b livree (carte album Hors-ligne a 2 actions + kebab, vue Artistes en un en-tete par artiste, compteur avec separateurs, onglet actif du panneau desktop ; 3 commits) fusionnee ; chaine 17b lancee. c18a/b/c en cours.\n"
if "Lane c17b livree" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 17d ok")
