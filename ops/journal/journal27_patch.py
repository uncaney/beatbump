import pathlib
p = pathlib.Path("/tmp/journal27.py"); s = p.read_text()
old = """- Serveur : l historique garde la plus grande vignette (plein ecran), les resultats de recherche conservent playerParams et musicVideoType, le verdict "deja dans la bibliotheque" est invalide apres une acquisition.
"""
new = old + """- Boutons : la regle de bouton globale retrouve sa specificite d origine (les 9 boutons rendus illisibles par le cycle 26 : paroles, page Hors-ligne, Vider la file, Video/Audio, Album Radio, Retour) ; "Tout lire" et "Explorer" passent sur le systeme de boutons ; toasts ancres au-dessus de la mini-barre (a droite sur desktop) sans bloquer le contenu.
- Harness : coeur 42 etapes avec un controle de contraste texte / fond sur les boutons de plusieurs ecrans.
"""
assert s.count(old) == 1
s = s.replace(old, new).replace("cycle 27 : c27a + c27b", "cycle 27 : c27a + c27b + c28a + correctif :where")
p.write_text(s); print("journal27 on box updated")
