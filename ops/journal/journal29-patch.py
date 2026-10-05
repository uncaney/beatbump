p="/tmp/journal29.py"; s=open(p).read()
old="""- Robustesse : remontee des erreurs client"""
new="""- Correctif de confidentialite (audit logique v8, P1) : la "Radio" des favoris n est plus servie depuis le cache partage (un profil pouvait recevoir pendant 5 minutes la radio des favoris d un autre profil) ; le cache d accueil instantane est vide au changement de profil.
- Robustesse : remontee des erreurs client"""
assert old in s; open(p,"w").write(s.replace(old,new,1)); print("journal29 patched")
