import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 09:10-09:25 UTC : chaine 16b (349499b) coeur 28/28, hors-ligne 11/12 : me_pages_offline_message KO = setOffline de Playwright n atteint pas les fetch du service worker (cible separee), le SW repondait avec les vraies donnees ; etape reecrite avec un contexte serviceWorkers:block (chemin fetch en echec + navigator.onLine). Lane c17a (Opus) livree : cause reelle du plein ecran sur /lyrics = deux minuteurs non annules dans +layout.svelte (open 425 ms arrivant apres closed, puis set(closed) a valeur egale non diffuse) ; en-tete album (artist.slice, explicite, repli Album · N titres · annee), zone de tap des liens artiste (overflow clip x), cibles 44 px restantes, petites capitales, badge lecture ListItem 36 px coin, chips bibliotheque centrees avec fondu, titre d onglet Paroles, kebab des cartes ; 8 commits. Fusionnee ; chaine 17a lancee.\n"
if "Lane c17a (Opus) livree" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 17a ok")
