import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 08:45-08:55 UTC : prod cycle 15 verifie (27/27 + 11/11), captures prod relancees. Audit UX v5 livre (audit-ux-v5.md : 1 regression P2 = \"Pour toi\" 3 cartes car randomLibrarySample lisait une fenetre contigue de 40 pistes = 3-4 albums ; TOP 10 : minuteur open 425 ms du layout qui ecrase closed (P1 plein ecran sur /lyrics), InfoBox artist.slice, overflow des liens artiste, cibles rem restantes, petites capitales Voir tout, badge lecture uniforme, chips bibliotheque, finitions). Opus : echantillon serveur en 10 fenetres de 4 pistes (607430e). Lane c17a-ux-v5 (Opus) lancee sur les TOP 1 3 4 5 7 8 9 10 ; TOP 6 (page Hors-ligne) reporte apres c16b.\n"
if "Audit UX v5 livre" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 17 ok")
