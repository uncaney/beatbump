import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-02 (heure box) — cycle 33 en prod (integration {head}) : audit logique v9 + audit perf v3
- Accueil plus rapide : la page d accueil n attend plus la reponse YouTube (servie depuis le cache, rafraichie en arriere-plan) et les rangees personnelles s affichent d abord ; une seule requete d historique par ouverture ; une seule ecriture du cache local par visite.
- Deploiements plus legers : le service worker reutilise les fichiers inchanges d une version a l autre au lieu de tout retelecharger, et ne precharge plus le lecteur video ni les polices non latines ; la recherche YouTube n embarque plus la reponse brute (resultats 3 fois plus legers, mis en cache hors-ligne) ; pochettes absentes memorisees une heure ; listes d artistes plus rapides.
- Robustesse : "Jamais ecoute" pagine sans recalculer les pages precedentes ; apercus de liens (robots) dans un cache dedie, jamais le repli, 4 recherches en parallele au plus ; adresse client lue uniquement derriere le proxy ; annuler un pack n interrompt plus le telechargement d une autre page ; carte "Ta semaine" masquee a 0 minute ; cartes artistes "Radio indisponible" au lieu d un clic muet ; filtre de recherche memorise une heure seulement.
"""
if "cycle 33 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- (heure box) : chaine 35 ({head}) verte ; promu (cycle 33 : c33a + c33b).\n"
if f"chaine 35 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 33 ok")
