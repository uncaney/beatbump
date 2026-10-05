import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = """
## 2026-10-01 07:00 UTC — cycle 12 en prod (integration 83ebc69) : audit logique v3 + polish UX 3
- Audit logique/fonctionnel v3 (audit-features-v3.md) : F1-F22 re-verifies (15 corriges, 2 partiels, 5 ouverts) + 22 nouveaux constats G1-G22 (0 P0, 4 P2) ; cycle 13 lance dessus.
- Pochettes : placeholder aux initiales de l artiste/album (plus de carte "?") quand aucune image n existe.
- Lecteur mobile : tiroir de file ferme = poignee seule (la pochette n est plus masquee) ; desktop : menu kebab aligne au centre des lignes.
- Bibliotheque : les cartes de hub en double (deja dans les onglets) sont retirees.
- Recherche : a l ouverture de la boite vide, rangee "Reprendre" (5 derniers morceaux locaux ecoutes), lecture directe.
- Captures UX (shots.cjs) : onglet Related, paroles avec morceau, bas des reglages.
"""
if "cycle 12 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 06:55-07:05 UTC : cycle 12 (audit logique v3 + c12b polish UX 3, 5 commits) fusionne 83ebc69 ; staging coeur 23/23, hors-ligne 11/11 ; promu 06:59 (tarball beatbump-prod-20261001-065913). Cycle 13 lance depuis 83ebc69 sur l audit v3 : c13a file/lecteur (G1 G2 G3 G4 G11 G13 G14 G21 G22), c13b hors-ligne/SW (G6 G7 G8 G15 G16 G20), c13c divers (G5 G9 G10 G12 G17 G18 G19 F19 F20).\n"
if "cycle 12 (audit logique v3" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal ok")
