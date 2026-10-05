import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 09:40 UTC : prod ab7244c verifie : coeur 28/28, hors-ligne 12/12 (me_pages_offline_message v3 passe : stub de fetch me/* dans la page, SW conserve). Captures prod relancees. Lane c17b (Opus) lancee sur les restes UX v5 : carte album Hors-ligne a 2 actions, vue Artistes sans doublons, separateurs du compteur, onglet actif du panneau desktop ; harness queue_reorder_next a ecrire.\n"
if "prod ab7244c verifie" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 17c ok")
