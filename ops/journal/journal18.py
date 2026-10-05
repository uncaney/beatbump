import pathlib
d = pathlib.Path("/srv/beatbump/agents/program")
cy = d/"CYCLES.md"; s = cy.read_text()
line = "- 09:45-09:55 UTC : brainstorm-v2.md livre (Opus, lecture seule) : bilan v1 (15 livrees), 34 idees faisables sans decision, 18 bloquees (12 decisions), TOP 12 pour les cycles 18-20 (C1 reprise exacte, O8 Garder hors-ligne, X1 Lire tout partout, P2 contexte de lecture, C4 continuer apres une file locale, O9 ecoutes hors-ligne en file, O10 stockage persistant, C3 ecran verrouille, V1 pastille pret hors-ligne, S3 historique par jour, W6 raccourcis d icone, C2 reprise multi-appareil). Cycle 18 lance depuis ab7244c (Opus) : c18a continuite (C1 C4 P2 C3), c18b hors-ligne (O8 V1 O9 O10), c18c bibliotheque (X1 S3 W6) ; c17b (restes UX v5 page Hors-ligne) toujours en cours. Harness : etape queue_reorder_next ecrite (29), validation sur staging en cours.\n"
if "brainstorm-v2.md livre" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("cycles 18 ok")
