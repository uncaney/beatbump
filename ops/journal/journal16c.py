import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 09:05 UTC : prod 607430e verifie : coeur 28/28 (lyrics_fast_after_open passe aussi en prod : la re-ouverture du plein ecran vue sur la capture mobile-20 ne se reproduit pas dans Chrome avec ce parcours ; shots.cjs enregistre desormais la metrique fullscreen_over_lyrics), hors-ligne 11/12 (me_pages_offline_message attendu KO jusqu a la promotion de c16b).\n"
if "prod 607430e verifie" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 16c ok")
