import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box) — cycle 31 en prod (integration {head}) : partage, apercu des liens, francais coherent
- Partage : bouton "Partager" sur le lecteur plein ecran et sur un album local (feuille de partage du telephone, sinon lien copie) ; les liens partages sur WhatsApp / Signal / Telegram / Discord / Slack affichent un apercu (titre, artiste, pochette) sans rien changer pour les navigateurs.
- "Tu l as deja" : sur un album YouTube que tu possedes deja en local, un bandeau mene a la version locale (hors-ligne, sans reseau).
- Langue : les ecrans crees par le programme sont entierement en francais (tailles en Mo / Go, compteurs, tri et filtre des listes, page Hors-ligne, A propos, menus d album) ; un test structurel empeche le retour de mots anglais sur ces ecrans. Les ecrans Beatbump d origine restent en anglais (decision 1 en attente).
"""
if "cycle 31 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- (heure box) : chaine 32 ({head}) verte ; promu (cycle 31 : c31a + c31b).\n"
if f"chaine 32 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 31 ok")
