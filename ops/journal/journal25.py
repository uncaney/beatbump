import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box ~13:00 UTC) — cycle 25 en prod (integration {head}) : performance (audit perf v2)
- Demarrage : la page n est plus montee deux fois (les appels me/mix, historique, albums ne partent qu une fois) et la transition de page passe de 1 s a 150 ms.
- Premier chargement : le service worker ne precharge que le shell et les morceaux de code necessaires, le reste arrive par lots en arriere-plan (plus de 256 requetes d un coup).
- Pochettes : /cover est cacheable une semaine et le service worker garde les 200 dernieres (un accueil repete ne recharge plus 22 images).
- Serveur : next.json, related.json et les suggestions de recherche passent par le cache TTL ; me/mix calcule en parallele et cache 60 s par profil ; reponses de recherche et d historique allegees (plus de donnees de tracking YouTube) ; fallback HTML en no-cache.
- Lecteur : etat de reprise ecrit seulement quand la file change (la position seule toutes les 5 s) ; index unique du cache audio dans le service worker ; cache API borne (200 entrees, < 300 Ko) ; profils anonymes ne sollicitent plus me/nowplaying.
- Harness : coeur 41 etapes (requetes du chargement a froid, pochette cacheable, caches API).
"""
if "cycle 25 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- 13:00 UTC (heure box) : chaine 25 ({head}) verte ; promu (cycle 25 perf : c25a + c25b).\n"
if f"chaine 25 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 25 ok")
