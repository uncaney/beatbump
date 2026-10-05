import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 08:55-09:05 UTC : chaine 16a (607430e) coeur 27/28 (seul KO = nouvelle etape lyrics_fast_after_open mal reglee, corrigee), hors-ligne 11/11, me/mix 40 titres sur 17 albums ; 607430e promu. Lanes Opus du cycle 16 livrees et fusionnees : c16b (pages me/* hors-ligne MeOffline data-testid=me-offline, favoris copie locale, dont X epingles + refus de quota, epinglage album coherent, Reprendre hors-ligne depuis le cache, Retelecharger desactive hors-ligne ; 4 commits), c16c (test Go spaRoots vs routes, 400 amont -> 502, messages fr: affiches, repeat-one compte chaque boucle via statsPlayCount.ts, refocus de la boite pleine ; 4 commits), c16a (relance media sans purge au 1er essai, jamais pinned/offline, Dedupe Automix effectif via applyMixOp, rebase du drag si la file change ; 3 commits, vitest 84). Integration 349499b ; chaine 16b lancee apres le harness prod. Harness : coeur 28 (lyrics_fast_after_open), hors-ligne 12 (me_pages_offline_message).\n"
if "chaine 16a (607430e)" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 16b ok")
