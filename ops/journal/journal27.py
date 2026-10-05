import pathlib, sys
d = pathlib.Path("/srv/beatbump/agents/program")
head = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
cl = d/"CHANGELOG.md"; s = cl.read_text()
entry = f"""
## 2026-10-01 (heure box) — cycle 27 en prod (integration {head}) : robustesse apres l audit v7
- Apres une mise a jour de l application, un morceau de code charge a la demande qui ne repond plus ne bloque plus la page : le lecteur se referme proprement, un toast propose de recharger, et le plein ecran est prechauffe des la premiere lecture.
- Reprise : la position sauvegardee ne peut plus etre orpheline apres une reprise distante ou un second onglet (generation + resynchronisation entre onglets) ; le bouton Retour et la transition de page suivent bien chaque navigation.
- Service worker : pochettes sans reecriture a chaque affichage, entrees audio orphelines reabsorbees, lots de prechargement rejoues s ils ont echoue, cache API borne de maniere fiable, liste des fichiers du shell verifiee par un test.
- Profils : une connexion ou deconnexion dans un onglet est vue par les autres (BroadcastChannel) ; etat verifie au retour sur la page.
- Serveur : l historique garde la plus grande vignette (plein ecran), les resultats de recherche conservent playerParams et musicVideoType, le verdict "deja dans la bibliotheque" est invalide apres une acquisition.
- Boutons : la regle de bouton globale retrouve sa specificite d origine (les 9 boutons rendus illisibles par le cycle 26 : paroles, page Hors-ligne, Vider la file, Video/Audio, Album Radio, Retour) ; "Tout lire" et "Explorer" passent sur le systeme de boutons ; toasts ancres au-dessus de la mini-barre (a droite sur desktop) sans bloquer le contenu.
- Harness : coeur 42 etapes avec un controle de contraste texte / fond sur les boutons de plusieurs ecrans.
"""
if "cycle 27 en prod" not in s:
    cl.write_text(s.rstrip("\n") + "\n" + entry)
cy = d/"CYCLES.md"; s = cy.read_text()
line = f"- (heure box) : chaine 27 ({head}) verte ; promu (cycle 27 : c27a + c27b + c28a + correctif :where).\n"
if f"chaine 27 ({head}) verte" not in s:
    cy.write_text(s.rstrip("\n") + "\n" + line)
print("journal 27 ok")
