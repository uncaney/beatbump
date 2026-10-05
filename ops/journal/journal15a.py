import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = """
## 2026-10-01 08:05 UTC — cycle 14b en prod (integration 9ad0f43) : finitions UX v4 (Opus solo)
- Artiste : Follow reste sur la rangee Play Radio / Shuffle sur telephone (une seule rangee des 360 px).
- Paroles : lignes cliquables et boutons A-/A+ a 44 px minimum sur mobile.
- Chips de contexte : fondu a droite au lieu d une chip coupee.
"""
if "cycle 14b en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 07:55-08:05 UTC : prod cycle 14 verifie (coeur 26/26, hors-ligne 11/11, API artiste inconnu 404). Lot solo 9ad0f43 (Follow en rangee, paroles 44 px, fondu des chips) : staging 26/26 + 11/11, promu 08:05. Worktrees c15a-player-queue / c15b-search-release crees pour la fenetre API 09:30 UTC (TOP 9, 3.7 candidats, TOP 7, 3.8 release, recherches recentes). Captures prod relancees pour l audit UX v5.\n"
if "Lot solo 9ad0f43" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 15a ok")
