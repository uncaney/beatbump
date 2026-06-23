# music.ekaii.fr — application musicale auto-hébergée

Fork de [Beatbump](https://github.com/giwty/Beatbump) transformé en application musicale
complète, auto-hébergée, pensée pour **posséder ses données** (own-the-data). L'objectif est
une parité de fonctionnalités avec YouTube Music / Spotify, mais sur une infrastructure que
l'on contrôle entièrement.

Trois principes :

- **Local et en ligne, de façon transparente.** Une recherche renvoie aussi bien la
  bibliothèque locale que le catalogue YouTube. Quand un morceau existe en local *et* en ligne,
  c'est **la meilleure qualité** qui est servie, sans que l'utilisateur ait à choisir.
- **La bibliothèque se construit toute seule.** Suivre un artiste ou aimer un morceau déclenche
  le téléchargement (lent, respectueux des quotas) du contenu correspondant. Plus on écoute,
  plus la bibliothèque locale s'enrichit.
- **Tout est vérifié automatiquement.** Chaque fonctionnalité est couverte par une suite de
  tests de bout en bout (Playwright) rejouée à chaque déploiement, sur poste *et* sur mobile.

---

## Accès et installation

L'application est accessible sur **https://music.ekaii.fr**.

Elle est installable comme application (PWA) : une fois installée, elle s'ouvre en plein écran
et fonctionne hors-ligne pour les morceaux téléchargés.

- **Android (Chrome)** : menu ⋮ → « Installer l'application » / « Ajouter à l'écran d'accueil ».
- **iOS (Safari)** : bouton Partager → « Sur l'écran d'accueil ».
- **Ordinateur (Chrome/Edge)** : icône d'installation dans la barre d'adresse.

Après une mise à jour, l'application se recharge automatiquement une fois pour récupérer la
nouvelle version (plus besoin de vider le cache à la main).

---

## Fonctionnalités

### Recherche et lecture

- Recherche unifiée locale + YouTube, avec suggestions.
- Lecture immédiate ; quand un titre existe en local et en ligne, la meilleure copie est servie.
- Lecteur persistant (barre du bas) avec file d'attente, lecture/pause, suivant/précédent,
  aléatoire, répétition.
- Lien artiste cliquable depuis le lecteur et chaque morceau.

### Bibliothèque

- Pages **Artistes**, **Albums**, **Titres**, **Genres** sous forme de grilles.
- Tri (titre, date d'ajout, etc.) et filtres ; chargement infini au défilement.
- Pages **artiste** (top titres + albums), **album** (tracklist) et **playlist** complètes,
  qu'il s'agisse de contenu local ou YouTube.
- Hub **Bibliothèque** : accès rapide à For You, Artistes, Albums, Titres, Genres, Favoris,
  Écoutes récentes, Hors-ligne et Compte.

### Radio et file d'attente

- **Radio par défaut** : lancer un morceau démarre une file infinie de titres similaires
  (radio YouTube réelle, y compris pour un morceau local dont on retrouve l'équivalent en ligne).
- Pré-chargement des titres suivants pour un enchaînement fluide.
- **Enregistrer la file** comme playlist.

### Compte et données personnelles

- Connexion par **nom** (profil multi-utilisateur, stocké côté serveur).
- **Favoris**, **artistes suivis**, **playlists serveur** (création, ajout/retrait de titres,
  suppression), **historique d'écoute** — tout persiste entre les sessions et les appareils.
- Sans connexion, un profil local anonyme conserve les mêmes fonctions sur l'appareil.

### Recommandations

- **For You / Made for you** : un mix construit à partir de vos écoutes et de vos favoris.
- Statistiques : titres récemment et le plus écoutés, top par artiste.

### Acquisition automatique

- **Suivre un artiste** déclenche le téléchargement progressif de sa discographie dans la
  bibliothèque locale (téléchargeur po-token, débit limité, via proxy résidentiel).
- File de téléchargements avec **pause / reprise / nouvelle tentative** par tâche.

### Qualité

- Score de qualité par morceau (codec, débit, échantillonnage).
- **Upgrade-in-place** : si la copie servie est en ligne ou de moindre qualité, une meilleure
  version est récupérée en arrière-plan et remplace l'ancienne, de façon transparente.

### Paroles

- Paroles synchronisées via [lrclib.net](https://lrclib.net) (universel), accessibles depuis le
  lecteur.

### Téléchargements

Trois modes, selon le besoin :

1. **Hors-ligne (dans l'app)** — met le morceau en cache via le service worker pour l'écouter
   sans connexion dans l'application installée.
2. **Sur l'appareil** — enregistre le vrai fichier audio (dossier Téléchargements / Fichiers)
   pour les morceaux déjà présents dans la bibliothèque locale.
3. **Côté serveur** — ajoute le morceau ou la discographie à la bibliothèque locale (voir
   Acquisition), avec file de tâches.

### Hors-ligne (PWA)

- Coquille de l'application et données déjà consultées disponibles hors-ligne.
- Les morceaux explicitement téléchargés « hors-ligne » se lisent sans réseau.
- Page dédiée listant les téléchargements hors-ligne.

### Mobile

- Lecteur plein écran tactile : boutons directs Retour, Voir l'artiste, Télécharger, Paroles ;
  fermeture par glissement vers le bas.

### Langues

- Recherche locale multilingue (Meilisearch). La recherche YouTube gère nativement les
  différentes écritures. La translittération romaji/pinyin n'est pas activée (pas de contenu
  CJK dans la bibliothèque actuelle).

---

## Comment faire…

- **Écouter quelque chose** : taper une recherche, cliquer un résultat. La radio s'enchaîne seule.
- **Voir un artiste** : menu ⋮ d'un morceau → « Voir l'artiste », ou cliquer le nom de l'artiste.
- **Aimer / suivre** : cœur pour un favori ; bouton « Suivre » sur une page artiste (déclenche
  l'acquisition de sa discographie).
- **Se connecter** : Bibliothèque → Compte → entrer un nom.
- **Télécharger pour le hors-ligne** : menu ⋮ → « Download offline » (ou les boutons du lecteur).
- **Installer l'app** : voir la section Installation ci-dessus.

---

## Architecture

Application servie par un unique conteneur (`beatbump-ekaii:local`, port 8080) : interface
SvelteKit (SPA statique) + backend Go/Echo qui agrège la bibliothèque locale et YouTube.

La pile complète (orchestrée par `docker-compose.yml`) :

| Service | Rôle |
| --- | --- |
| **beatbump** | L'application (interface + API). |
| **meili** (Meilisearch) | Index du catalogue local (titres / albums / artistes). |
| **indexer** (`ytm-indexer`) | Indexe la bibliothèque dans Meilisearch, calcule le score qualité. |
| **ytm-cache** (le « bridge ») | Résolution transparente local/online (meilleure copie), sert les fichiers locaux et les pochettes, met en cache à la lecture. |
| **Invidious** + **companion** (+ bgutil po-token) | Oracle YouTube : flux audio et radio. |
| **ytify** | Lecteur YouTube complémentaire auto-hébergé. |
| **Navidrome** + **Yubal** | Bibliothèque own-the-data et téléchargeur po-token. |
| Égress résidentiel | Proxies sortants pour contourner le blocage des IP de datacenter par YouTube. |

L'application est exposée publiquement derrière le mur anti-bot (Anubis) et le reverse-proxy
du NAS.

---

## Référence API (résumé)

Préfixe `/api/v1`. Routes principales :

- **Catalogue / lecture** : `search.json`, `player.json`, `next.json`, `related.json`,
  `playlist.json`, `main.json`, `home.json`, `trending`, `explore`,
  `get_search_suggestions.json`, `get_queue.json`.
- **Bibliothèque locale** : `local/artists`, `local/albums`, `local/songs`, `local/genres`
  (paginés, triables, filtrables).
- **Compte et données** : `login`, `logout`, `whoami`, `favorites`, `follows`,
  `playlists` (+ `playlists/:id/items`), `history`, `stats/recent`, `stats/top`, `mix`.
- **Acquisition / téléchargements** : `acquire`, `downloads` (+ `:taskId/pause|resume|retry`),
  `download/song`, `download/playlist`, `stream/:taskId/:videoId`.
- **Divers** : `lyrics`, `settings`, `artist/:artistId`.

---

## Développement

```sh
# Construire l'image (interface + backend)
docker build -t beatbump-ekaii:local .

# Déployer dans la pile
docker compose up -d --force-recreate beatbump
```

- Interface : `app/` (SvelteKit). Backend : `backend/` + `main.go` à la racine (Go/Echo).
- Code spécifique au fork côté backend : `backend/api/local_search.go`, `local_pages.go`,
  `local_browse.go`, `related.go`, plus les modèles compte/favoris/playlists.

### Tests de bout en bout

Une suite Playwright (`e2e/`) rejoue les parcours clés (recherche → lecture → radio,
navigation artiste/album, favoris, playlists, suivi → acquisition, hors-ligne, lecteur mobile)
sur poste et sur mobile émulé, avec captures d'écran et journaux. Elle est lancée après chaque
déploiement et échoue si un parcours casse.

---

## Crédits et licence

Basé sur [Beatbump](https://github.com/giwty/Beatbump) (giwty). Ce dépôt en est un fork
maintenu indépendamment ; les fusions amont nécessitent un re-patch. Voir le projet d'origine
pour la licence.
