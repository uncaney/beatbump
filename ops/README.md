# agents/ops : scripts d exploitation de music.ekaii.fr

Cycle 34 (lane c34c-ops, items OP2, OP3, SM1, SM2 de `program/brainstorm-v5.md`). Tout se lance SUR la box
`docker-host`, depuis le Mac via `ssh -o ControlMaster=no -o ControlPath=none docker-host '...'`. Voir aussi
`program/RUNBOOK.md` (sections 2 a 4).

## Contenu

| Fichier | Role |
|---|---|
| `stage-cycle.sh` | chaine staging : build de `agents/integration` en `beatbump-ekaii:staging` (sous `flock /tmp/beatbump-build.lock`, `--build-arg VERSION=<sha court>`), redemarrage du staging, chauffe, controles d en-tetes, harness coeur puis hors-ligne. Copie versionnee de `/tmp/ytm-stage-cycle2.sh`, meme comportement. Ne promeut rien. |
| `journal.py` | ecrit l entree `CHANGELOG.md` et la ligne `CYCLES.md` d une promotion, a partir de `journal/cycle-<N>.md`. Idempotent (marqueur). |
| `journal/` | copies des anciens `/tmp/journal*.py` (archive, ne plus les lancer) et un fichier texte `cycle-<N>.md` par cycle promu. |
| `finish-cycle.sh` | fin de cycle generique (cycle 39) : chaine `stage-cycle.sh`, DS1 optionnelle, `promote.sh`, `journal.py`, sonde post-deploiement, harness prod. Remplace les `/tmp/ytm-c3*-finish.sh` / `-promote.sh`. |
| `weekly.sh` | mesures du lundi : une ligne dans `program/WEEKLY.md` (11 colonnes depuis le cycle 53 : harness avec auto-controle de palier et d age, accueil, bibliotheque, Kuma, client-log, usage, acquisition, disque, sauvegardes image, API lente, retention 7 j), un bloc dans `program/ALERT.md` si seuil franchi. Secrets par env ou stdin seulement. |
| `monday.sh` | le lundi en une commande (cycle 53, B9-15) : attente d une box libre, harness prod palier `full` coeur + hors-ligne, `weekly.sh` (`WEEKLY_DB_RO=1`), `smoke.sh` HTTP avec `SMOKE_ALERT=1` ; journal `program/logs/monday-<date>.log` (10 gardes) ; code de sortie = le pire des trois. |
| `archive/` | copies en lecture seule des scripts `/tmp/ytm-c37..c40-*.sh` (ne plus les lancer), une ligne chacun dans `archive/README.md`. |
| `cron.weekly.example` | les deux lignes de crontab de la decision 19 : `monday.sh` lundi 06:00 UTC, `smoke.sh` tous les jours 06:30 UTC. NON installees. |
| `cleanup-harness-profiles.sh` | compte par motif et IMPRIME la purge des profils `harness-*` (noms fixes gardes) ; `--execute` exige `YTM_CONFIRM=yes` (cycle 42). |
| `../../e2e/steps-c42-core.cjs` | etapes harness du cycle 42 (L12-2) : vrais gestionnaires MediaSession, skip reel + exclusion, album du jour par date. Voir plus bas. |
| `smoke.sh` | smoke test SM1 : 11 controles HTTP en moins de 90 s, sans navigateur, sans acquisition. |
| `../promote.sh` | promotion de l image staging testee en prod (durci au cycle 34, voir plus bas). |
| `../../e2e/probe-deploy-survives.cjs` | sonde DS1 : un profil navigateur PERSISTANT qui traverse deux builds (garde SM2). |

## stage-cycle.sh

```
nohup /srv/beatbump/agents/ops/stage-cycle.sh > /tmp/ytm-stage-cycle<N>.log 2>&1 &
grep -E "^(=== |PASS|FAIL|Report|staging HTTP)" /tmp/ytm-stage-cycle<N>.log
```
Toujours detache avec son log (`/tmp/ytm-stage-cycle<N>.log`, N = numero de chaine). Jamais de harness prod
pendant qu une chaine tourne. Pour modifier le script pendant une chaine : ecrire un fichier temporaire puis `mv`.

## journal.py

```
python3 /srv/beatbump/agents/ops/journal.py 33 <sha promu> --chain <N> --dry-run   # relire
python3 /srv/beatbump/agents/ops/journal.py 33 <sha promu> --chain <N>             # ecrire
```
Un nouveau cycle = un nouveau fichier `journal/cycle-<N>.md`, pas de code. Format (en tete, lignes meta) :
```
<!-- marker: cycle 34 en prod -->
<!-- cycles: - {now} : chaine {chain} ({head}) verte ; promu (cycle 34 : c34a + c34b). -->
<!-- cycles-marker: promu (cycle 34 : c34a + c34b) -->
## {date} {time} UTC (horloge box) : cycle 34 en prod (integration {head}) : titre
- puce
```
Jetons : `{head}` (2e argument), `{chain}` (`--chain`), `{date}` `{time}` `{now}` (horloge `date -u` de la box).
Un jeton sans valeur (y compris un `{xxx}` inconnu) arrete le script AVANT toute ecriture. Depuis le cycle 39 :
`<head>` doit etre un sha court (`^[0-9a-f]{7,12}$`), `cycles-marker:` est obligatoire si `cycles:` contient
`{now}`/`{date}`/`{time}`, une relance du meme cycle affiche `deja present, rien a ecrire` pour chaque fichier puis
`journal <cycle> : rien a ecrire ... inchanges`, et `--dry-run` imprime les lignes exactes qui seraient ajoutees.

## smoke.sh

```
/srv/beatbump/agents/ops/smoke.sh https://music.ekaii.fr [sha attendu]
/srv/beatbump/agents/ops/smoke.sh https://staging-music.ekaii.fr
```
Controles : `stats/library` (200, `tracks > 0`, `version`, et egalite au sha attendu s il est donne), coquille
`/home` avec le script d entree `_app`, `/service-worker.js`, `share_target` dans `/manifest.json`,
`search.json?q=daft+punk` sous 300 Ko, `local/albums?limit=1`, `local/related?seed=album:<id>`, Range `/localf`
sur une piste locale (206 + `Accept-Ranges`), `/cover?lid=<pochette de l album>` avec `Cache-Control`, carte
`og:title` pour un robot sur `/listen?id=<piste locale>`, `X-Ytm-Cache: HIT` au 2e appel de `local/mixes`.
Une ligne `OK` / `FAIL` par controle, puis `SMOKE ... : n ok, m echec(s) en s s`. Code 1 si un echec.
Seuls des ids LOCAUX sont utilises (`player.json` n est appele qu avec un lid : reponse depuis l index local,
avant toute acquisition). Lecture seule, peut tourner pendant un build (pas de navigateur).

### Controle 0 : garde de l image prod (cycle 59, c59e)
`prod_image_tag` compare l id de l image du conteneur `ytm-beatbump` au tag `beatbump-ekaii:local`. Tag absent (elagage Coolify de 00:00, store containerd) : `docker load` du tarball `image-backups/beatbump-prod-*-<id>.tar.gz` puis verification que le tag redonne l id du conteneur ; avec `SMOKE_ALERT=1` un bloc "image prod restauree" est ecrit dans `program/ALERT.md`. Tag present mais different : promotion en cours ou tag devie, rien n est touche, FAIL explicite. Sans ce tag : DS1 "same build served", pas de rollback, `compose up` en echec.

## finish-cycle.sh (cycle 39)

```
FINISH_PARSE_ONLY=1 sh /srv/beatbump/agents/ops/finish-cycle.sh 42 45 --ds1        # arguments + garde SM2 du moment
printf 'app/src/lib/utils/sharedJobs.ts\n' | FINISH_GUARD_TEST=- sh /srv/beatbump/agents/ops/finish-cycle.sh   # test de la garde
nohup sh /srv/beatbump/agents/ops/finish-cycle.sh <cycle> <chain> [--ds1] [--no-promote] [--wait] >/dev/null 2>&1 &
tail -f /tmp/ytm-finish-<cycle>.log          # derniere ligne : FINISH <cycle> DONE
sh /srv/beatbump/agents/ops/finish-cycle.sh --help
```
- refuse de demarrer si un conteneur `ytm-harness-*` tourne (l affiche), sauf `--wait` (attente par 60 s, 60 min
  max) ; refuse si `/tmp/ytm-stage-cycle<chain>.log` existe deja ou si `journal/cycle-<cycle>.md` manque ;
- chaine : `stage-cycle.sh > /tmp/ytm-stage-cycle<chain>.log` ; verte = les deux lignes
  `Report: P passed / F failed / U upstream` avec `F = 0` (coeur `P >= FINISH_MIN_CORE`, defaut 50 ; hors-ligne
  `P >= FINISH_MIN_OFF`, defaut 17) et le staging sert le sha de HEAD `agents/integration` ;
- `--ds1` : sequence de la garde SM2 ci-dessous (seed sur l image prod, upgrade, rollback, staging remis sur NEW,
  verifie) ; verte = `fails` vide dans `e2e/out/ds1-upgrade.json` et `ds1-rollback.json` ecrits pendant ce run.
  Sans `--ds1`, si la garde SM2 s applique, pas de promotion (`DS1 REQUIS`, raisons dans le log, exit 3) ; la
  garde est journalisee a chaque run (`garde SM2 (prod <sha> -> <sha>) : ...`) ;
- puis (sauf `--no-promote`) `flock /tmp/beatbump-build.lock sh agents/promote.sh <sha>` (sortie complete dans le
  log ; exit != 0 = arret sans journal), `journal.py <cycle> <sha> --chain <chain>`, `probe-postdeploy.cjs`
  (4 min), harness prod coeur puis hors-ligne.
- codes : 0 fini, 1 refus / usage, 3 pas vert (rien promu), 4 `promote.sh` en echec.

### Fin de cycle : une seule voie (cycle 41)

Regle : **seul `finish-cycle.sh` termine un cycle a partir de maintenant.** Plus de `/tmp/ytm-c<N>-finish.sh` ni
`-promote.sh` ecrits a la main : les 7 scripts des cycles 37 a 40 sont archives dans `archive/` (lecture seule,
une ligne chacun dans `archive/README.md`). Un besoin que `finish-cycle.sh` ne couvre pas devient une option du
script (passee par `FINISH_PARSE_ONLY=1` puis `sh -n`), pas un nouveau script dans `/tmp`.

Enchainer un cycle apres une fusion (motif des files `ytm-c39-queue.sh` / `ytm-c40-queue.sh`) :
1. un petit script de file, detache (`nohup sh <file> > /tmp/ytm-c<N>-queue.log 2>&1 &`), attend en boucle
   (`sleep 15`, borne de 1 a 2 h, puis abandon propre avec une ligne `... QUEUE DONE`) deux conditions :
   la ligne de fin du cycle precedent dans son log (ex. `FINISH <N-1> DONE` dans `/tmp/ytm-finish-<N-1>.log`)
   ET un **fichier marqueur** `/tmp/ytm-c<N>-ready`, pose a la main (`touch`) par la session qui a fusionne
   les lanes du cycle N dans `agents/integration` ;
2. il active les etapes du cycle dans le harness (`sed` sur `C<N>_SKIP` de `e2e/harness-core.cjs` puis
   `node --check`) ;
3. il lance `sh agents/ops/finish-cycle.sh <N> <chaine> [--ds1] --wait` : `--wait` attend la fin d un
   `ytm-harness-*` en cours (60 s, 60 min max) au lieu de refuser.
Sans marqueur, rien ne part : la fusion reste la seule decision humaine (ou de session) du motif.

## weekly.sh (cycles 36 et 39)

```
WEEKLY_DRY_RUN=1 sh /srv/beatbump/agents/ops/weekly.sh      # affiche la ligne, n ecrit rien
sh /srv/beatbump/agents/ops/weekly.sh                       # ajoute la ligne a program/WEEKLY.md
# avec la cle Kuma, depuis le Mac apres "secret-store request" (le clair ne quitte pas <secret store>) :
{ printf 'WEEKLY_KUMA_KEY='; cat <secret store>/<nom>; echo; } | \
  ssh -o ControlMaster=no -o ControlPath=none docker-host 'sh /srv/beatbump/agents/ops/weekly.sh -'
```
- secrets (L11-3) : plus jamais de chemin de fichier en `$1` (refuse, exit 2). Sources : variables
  `WEEKLY_KUMA_KEY` et `YTM_ADMIN_TOKEN`, ou `-` puis des lignes `NOM=valeur` sur stdin. Ils sont retires de
  l environnement des sous-processus et passes a `curl` par `-K -` (fichier de config sur stdin : rien dans `ps`).
- colonnes ajoutees au cycle 41 (apres (e), meme format `| texte`) :
  - `usage 7 j : N ecoutes hors harness (M harness), K IP clientes distinctes dont P privees` : POST
    `/api/v1/me/history` 2xx du journal d acces Echo de `ytm-beatbump` ; harness = UA HeadlessChrome, ytm-perf,
    curl, python, Go-http, Uptime-Kuma. Les IP sont un PROXY des profils actifs (pas de cookie `bbp` dans les
    logs ; LAN et box confondus sous l IP privee du proxy) ;
  - `acquisition : ... pistes telechargees, ... deja presentes, ... echecs de piste, ... taches en echec,
    dernier telechargement <date>` : journal `docker logs -t --since 168h ytm-yubal` ;
  - `disque : bibliotheque <chemin> X libres (P %), /srv/data ...` : `df` sous `timeout 10` (NFS), chemin = source
    du montage `/app/data` de `ytm-yubal` ;
  - `sauvegardes image : N (T Mo)` : `image-backups/*.tar.gz` ;
  - `API lente (p90) : 3 prefixes` : uri `/api/` (ids -> `:id`, flux `/localf` `/vp` `/aud/` `/cover` exclus,
    >= 5 requetes).
  - `client-log` sans `YTM_ADMIN_TOKEN` : `client-log : N envois (7 j) via logs (http <code>=n, ...)` (POST comptes dans
    le journal d acces) ; avec le jeton, l API comme avant.
  - Limite : `docker logs` ne couvre que la vie du conteneur ; `promote.sh` recree `ytm-beatbump`, la fenetre
    reelle est donc affichee (`logs depuis 01/10 22:21, 0,1 j`). Traefik (`/data/coolify/proxy/access.log`)
    n aide pas : `RequestPath` y est supprime.
- alerte : un bloc est ajoute a `program/ALERT.md` si le dernier rapport prod coeur ou hors-ligne a un echec (ou
  manque), si la version servie differe du dernier `PROD = <sha>` de `program/CYCLES.md`, si le volume de la
  bibliotheque ou `/srv/data` a moins de 10 % libre (ou `df` ne repond pas en 10 s), si yubal n a telecharge
  aucune piste sur la fenetre alors qu il y a des echecs, ou (avec la cle Kuma) si le moniteur 167 est DOWN ;
  raisons sur stderr, stdout = la ligne WEEKLY seule. En `WEEKLY_DRY_RUN=1`, `ALERT.md` n est pas ecrit.
- endpoint propose (NOTE, pas de code Go) : `GET /api/v1/stats/usage?days=7` derriere `YTM_ADMIN_TOKEN`, renvoyant
  `{plays, profilesActive, profilesNamed, profilesAnon, lastNamedPlayAt}` agreges depuis
  `play_events` (les ecoutes harness n y sont deja pas, `harnessRequest` ; aucun nom, aucun titre) : remplacerait l approximation par IP et survivrait aux redemarrages.
- cron propose (non installe) : `cron.weekly.example` (depuis le cycle 53 : `monday.sh`, qui enchaine harness full, weekly.sh et smoke).
- cycle 53 (lane c53a, B9-14) : la colonne (a) retient le DERNIER rapport prod de palier `full` par genre (coeur
  = etape `perf_cold_home_requests`, hors-ligne = etape `load_home`), verifie son age (`finishedAt`, limite
  `WEEKLY_MAX_REPORT_AGE_D`, defaut 8 j) et imprime `tier=full, age N j, firstSound=M ms, gated=[...]`.
  Raisons d alerte ajoutees : aucun rapport full (le dernier rapport prod est affiche avec son `tier`), rapport
  full plus vieux que la limite, liste `gated` non vide alors qu une ligne WEEKLY d au moins 7 j en portait une.
  Test : `WEEKLY_MAX_REPORT_AGE_D=0 WEEKLY_DRY_RUN=1 sh weekly.sh` -> `ALERT (dry-run ...)` sur stderr.
- cycle 53 (lane c53a, B9-16) : colonne (k) `retention 7 j`, seulement avec `WEEKLY_DB_RO=1` (pose par
  `monday.sh` ; sinon `n/a`) : lecture SEULE de `beatbump-db/beatbump.db` (`sqlite3` URI `mode=ro` +
  `PRAGMA query_only`, chemin = source du montage `/db` de `ytm-beatbump`). Formule : profil HARNESS =
  `profiles.name LIKE 'harness-%'` OU toutes ses ecoutes `play_events` (historique entier) sont des fixtures
  (`ref` = `acquiredVideoId` / `localLid` de `e2e/fixtures.json` ou `9bZkp7q19f0`, titre contenant "gangnam
  style", artiste = `localAlbumArtist` / `localArtistName`) ; humain = au moins une ecoute hors fixtures.
  Imprime : profils humains actifs sur [J-7, J) (avec, entre parentheses, ceux de [J-14, J-7) et les
  "revenus" = intersection), ecoutes humaines 7 j et mediane par jour UTC, derniere ecoute humaine, nombre de
  profils exclus. Remplace l approximation par IP de (g) pour la retention ; (g) reste pour la fenetre du
  conteneur. Aucune ecriture : `ls -l beatbump-db/` inchange apres le run. Base du 02/10 (brainstorm-v9
  section 0) : 3 profils humains, 0 revenu (moins de deux semaines de donnees).

## Profils harness-* (cycles 39 et 42)

Le harness cree des profils nommes (id `u-<16 hex de sha1(nom en minuscules)>`, `backend/api/me.go`
`MeLoginHandler`) :

| Motif | Origine | Ou |
|---|---|---|
| `harness-blank-<ms>` | `steps-c38-core.cjs` `blank_profile_empty_states`, un par run | prod + staging |
| `harness-id-<ms>` | `harness-core.cjs` c39 `identity_migration` | staging |
| `harness-take-<ms>` | `harness-core.cjs` c40 `resume_take_over` | staging |
| `harness-remote-<id>` | `harness-core.cjs` `resume_remote` | prod + staging |
| `harness-skip-<ms>` | `steps-c42-core.cjs` `skips_exclusion_real` | staging |
| `harness-np`, `harness-days`, `harness-remote` | noms FIXES reutilises a chaque run (ne s accumulent pas) | prod + staging |
| autres `harness-*` | compte a part, avec exemples | |

Purge par defaut = `name GLOB 'harness-*'` SAUF les noms fixes (`--include-fixed` les ajoute). Tables (GORM,
`backend/db/me_models.go`) : `profiles`, et par `profile_id` `favorites`, `follows`, `playlists` (+ `playlist_items`
par `playlist_id`), `play_events`, `now_playings`, `skip_events` (ajoutee au cycle 42 ; une table absente est sautee).
Aucune route API ne supprime un profil : la purge se fait en SQL.
```
sh /srv/beatbump/agents/ops/cleanup-harness-profiles.sh                    # prod : compte par motif + SQL
sh /srv/beatbump/agents/ops/cleanup-harness-profiles.sh --staging          # staging (agents/staging-db)
YTM_CONFIRM=yes sh /srv/beatbump/agents/ops/cleanup-harness-profiles.sh --staging --execute
```
Lecture seule par defaut (`mode=ro`). `--execute` : `YTM_CONFIRM=yes` obligatoire, droit d ecriture sur la base,
son `-wal`, son `-shm` et son dossier. **Prod : refuse sauf en root** (base `root:root 644`, decision Camille : purge
prod manuelle, en root). **Staging** : prevu pour `--execute`, mais au 02/10 `agents/staging-db/beatbump.db*` sont
aussi `root:root 644` (ecrits par le conteneur) : il faut root, ou un `chown` de ces fichiers vers `docker-host`
(decision Camille). Comptes du 02/10 : staging 45 `harness-*` (blank 5, id 4, take 1, remote-* 33, np 1, days 1 ;
43 a purger), prod 2 (remote-* 1, days 1).

## steps-c42-core.cjs (cycle 42, L12-2)

Module comme `steps-c38-core.cjs` : aucun effet au chargement, tout dans `run(deps)`. Ligne a inserer dans
`e2e/harness-core.cjs` apres les etapes c41 (avant le rapport) :
```
  await require("./steps-c42-core.cjs").run({ page, browser, ctx, URL, QUERY, step, pollUntil, sleep, media, loginAs, fixtures: FIX });
```
Garde : `C42_SKIP` (Set exporte), env `C42_SKIP="a,b"`, `C42_STEPS_ENABLED=0` ; `skips_exclusion_real` saute hors
staging. Etapes (`STEP_NAMES`) :
- `mediasession_real_handlers` : contexte neuf, `addInitScript` qui enveloppe `navigator.mediaSession.setActionHandler`
  (gestionnaires dans `window.__ms`) et `play()` (element dans `window.__ytmMedia.el`) ; un titre de la
  bibliotheque, `__ms.nexttrack()` (position 1 de la file), `__ms.seekto({seekTime: 0})` -> `currentTime < 1`,
  `__ms.previoustrack()` apres 5 s -> meme titre reparti a 0, puis `previoustrack()` a moins de 3 s -> autre titre
  (normalement le premier).
- `skips_exclusion_real` (staging, `YTM_STATS_INCLUDE_HARNESS=1`) : profil `harness-skip-<ms>`, une ecoute + un
  favori du lid de fixture (graines de `me/mix`), une ref de `me/mix` (de preference aussi dans la radio de l album
  de fixture) sautee deux fois (`POST me/skips`, `at` distants de 60 s, `source: "player"`), `me/skips` la montre x2,
  elle disparait de `me/mix` et de `local/related?seed=album:<fixture>&personal=1` ; ce dernier repond
  `X-Ytm-Cache: BYPASS` (requete Node sur 127.0.0.1 avec SNI). Limite : une ref sautee dans les 3 h est deja exclue
  par `recentRefs` ; le seuil "2 sauts" seul reste prouve par `me_exclusions_test.go`.
- `album_of_day_stable` : deux appels, meme `browseId` ; `?date=<jour>` = sans date ; `?date=<lendemain>` differe ;
  date mal formee -> 400 ; dates hors bornes (1970-01-01, J+400) -> 400 attendu apres c42a, tolere (200 = assertion
  sautee, dit dans le detail). Joue a blanc le 02/10 sans navigateur : PASS staging et prod, bornes pas encore en place.

## promote.sh (cycles 34 et 39)

Cycle 39 (L11-2, copie : `promote.sh.bak-c39d`) :
- sauvegarde par `docker save -o <tar>.tmp.tar`, `gzip -1`, `gzip -t`, taille > 10 Mo, puis `mv` vers le nom final ;
  la rotation (3 tarballs les plus recents) ne tourne QUE si ce nouveau tarball est valide ;
- sauvegarde ratee : `!!!!! WARNING: sauvegarde image ECHOUEE`, `beatbump-ekaii:local` remis sur le tag
  `prod-backup-<TS>`, prod NON recreee, exit 2 ;
- prod HTTP != 200, version servie illisible ou != attendue, smoke en echec : lignes ROLLBACK affichees, puis
  `!!!!! WARNING: promotion <TS> en ECHEC (...)` et exit 3 ; sinon `promotion <TS> OK (exit 0)` ;
- le tarball de rollback affiche est verifie (`gzip -t`) ; chemins entre guillemets, `xargs -d '\n'`.

Cycle 34 :

```
sh /srv/beatbump/agents/promote.sh [sha attendu]
```
Ajouts par rapport a la version precedente (copie : `promote.sh.bak-c34c`) :
- version attendue : l argument, sinon la `version` servie par `ytm-beatbump-staging` SI ce conteneur tourne sur
  l image `beatbump-ekaii:staging` (le Dockerfile ne pose pas de label : la version n existe que dans le binaire) ;
- garde seulement les 10 `docker-compose.yml.pre-sameorigin-*` les plus recents (43 avant le cycle 34) ;
- sonde finale sans acquisition : `stats/library` puis Range `/localf` sur une piste de `local/songs?limit=1`
  (plus de `player.json?videoId=dQw4w9WgXcQ`) ;
- `version servie = <sha> OK`, ou une ligne `!!!!! WARNING` si elle differe de l attendue ou est illisible, ou
  si `beatbump-ekaii:staging` est deja l image prod (rien a promouvoir) ;
- commandes de rollback exactes : par le tag `prod-backup-<TS>` et par le tarball precedent (chemin complet,
  id d image, compose `pre-sameorigin-<TS>`), plus la version a reverifier ;
- appel de `ops/smoke.sh https://music.ekaii.fr <sha>` a la fin : `smoke 0 echec` ou `!!!!! WARNING`.

Apres la promotion : sonde post-deploiement, 90 s d attente, harness prod coeur et hors-ligne (RUNBOOK 2.3),
puis `journal.py` (tout cela est enchaine par `finish-cycle.sh`). Un appelant doit lire le code de sortie : ne
pas le perdre dans un pipe (`promote.sh ... | grep` renvoie le statut de `grep`).

## Garde SM2 : quand la sonde deploy-survives est obligatoire

Regle (cycle 42, L12-3) : la garde est FERMEE par defaut. La sonde DS1 `deploy_survives` doit passer (upgrade ET
rollback) AVANT `promote.sh`, en plus des harness coeur et hors-ligne verts, des qu un des cas suivants est vrai
(`sm2_guard` de `finish-cycle.sh`, une raison par ligne) :

| Cas | Raison imprimee | DS1 |
|---|---|---|
| `stats/library` prod sans `version` (prod hors service, JSON illisible) | `(version prod illisible ...)` | requis |
| version servie qui n est pas un sha hexadecimal de 7 a 40 caracteres | `(version prod '...' n est pas un sha)` | requis |
| sha inconnu de `agents/integration` ou ambigu (`git rev-parse --verify <sha>^{commit}` echoue : correctif fait ailleurs, image reconstruite hors integration) | `(sha prod ... inconnu de l integration ou ambigu ...)` | requis |
| sha connu mais pas ancetre de HEAD (`git merge-base --is-ancestor`) : le diff ne dit rien | `(sha prod ... n est pas un ancetre de HEAD ...)` | requis |
| `git diff --name-only <prod>..HEAD` en echec | `(git diff ... en echec)` | requis |
| `app/src/service-worker.ts` illisible a HEAD (imports non calculables) | `(imports de app/src/service-worker.ts illisibles a HEAD)` | requis |
| un fichier du motif `SM2_RE` a change (liste ci-dessous) | le chemin | requis |
| un fichier importe (transitivement) par le SW a change | `<chemin> (importe par le SW)` | requis |
| sha prod ancetre de HEAD et aucun fichier SM2 change | rien (`pas de DS1 requis`) | facultatif |

Motif `SM2_RE` : `app/src/service-worker.ts`, `app/src/routes/+layout.svelte`, `app/src/routes/+layout.ts`,
`app/vite.config.*`, `app/svelte.config.js`, `app/scripts/svelteRuntimeChunk.ts` (nommage des chunks precaches),
`app/src/lib/utils/sharedJobs.ts`, `app/src/app.html`, `app/static/manifest.json`. Imports du SW (`sw_imports`) :
lus a HEAD par `git show`, specificateurs `$lib/...` (-> `app/src/lib/...`), `./`, `../` des lignes
`import|export ... from "..."`, `import "..."`, `import("...")`, recursivement (extensions `.ts .js .svelte /index.ts
/index.js`) ; paquets npm et modules virtuels (`$service-worker`, `$app/...`) ignores. Au 02/10 : seul
`app/src/lib/utils/sharedJobs.ts`. Non couvert : un changement de version d un paquet npm importe par le SW
(`app/package.json` / lockfile) ; jouer `--ds1` a la main dans ce cas.

1. Savoir si la garde s applique (lecture seule) :
```
FINISH_PARSE_ONLY=1 sh /srv/beatbump/agents/ops/finish-cycle.sh <cycle> <chaine>   # ligne "garde SM2 maintenant"
# tester la garde sur une liste de fichiers (exit 0 = pas de DS1, 3 = DS1 requis) :
printf 'app/src/lib/utils/sharedJobs.ts\nbackend/api/me.go\n' | FINISH_GUARD_TEST=- sh /srv/beatbump/agents/ops/finish-cycle.sh
FINISH_GUARD_TEST=/tmp/liste FINISH_GUARD_PRODV=deadbee sh /srv/beatbump/agents/ops/finish-cycle.sh   # sha inconnu -> 3
```
   `FINISH_GUARD_PRODV` remplace le sha prod (defaut : HEAD, donc seuls les fichiers comptent) ;
   `FINISH_GUARD_IG=<depot jetable>` remplace `agents/integration` (test des cas "pas ancetre" et imports
   transitifs, joue le 02/10 dans un depot `/tmp/c42-guard-repo.*` supprime ensuite).
2. Jouer DS1 (sequence du 01/10 17:31, chaine staging verte deja faite, aucun autre navigateur en cours ; le
   staging sert tour a tour l image prod puis la nouvelle) :
```
cd /srv/beatbump/agents
NEW=$(docker image inspect -f '{{.Id}}' beatbump-ekaii:staging)   # image testee (nouveau build)
OLD=$(docker image inspect -f '{{.Id}}' beatbump-ekaii:local)     # image prod
up() { docker tag "$1" beatbump-ekaii:staging && docker compose --env-file /srv/beatbump/.env -f /srv/beatbump/agents/staging-compose.yml -p ytm-staging up -d 2>&1 | tail -1; sleep 25; curl -s --resolve staging-music.ekaii.fr:443:127.0.0.1 https://staging-music.ekaii.fr/api/v1/stats/library; echo; }
cd /srv/beatbump/e2e
up "$OLD"; ./run.sh https://staging-music.ekaii.fr "daft punk" probe-ds1-seed.cjs 2>&1 | grep -E "^\[ds1|FATAL"
up "$NEW"; ./run.sh https://staging-music.ekaii.fr "daft punk" probe-ds1-verify-upgrade.cjs 2>&1 | grep -E "^\[ds1|FATAL"
up "$OLD"; ./run.sh https://staging-music.ekaii.fr "daft punk" probe-ds1-verify-rollback.cjs 2>&1 | grep -E "^\[ds1|FATAL"
up "$NEW"   # TOUJOURS restaurer : promote.sh promeut le tag beatbump-ekaii:staging
```
   `run.sh` ne transmet pas d argument apres le nom du harness : les fichiers `probe-ds1-*.cjs` (une ligne
   chacun, `process.argv.push("--phase=...", "--label=...")` puis `require("./probe-deploy-survives.cjs")`)
   fixent la phase. Lancer la sequence detachee avec son log (`nohup sh -c '...' > /tmp/ytm-ds1-<N>.log 2>&1 &`).
3. Critere : les lignes `[ds1 verify:upgrade] PASS` et `[ds1 verify:rollback] PASS` (resultats dans
   `e2e/out/ds1-upgrade.json` et `e2e/out/ds1-rollback.json`, champ `fails` vide) : SW change, 0 `_app` en 404,
   epingles conserves, recherche utilisable, titre repris, au plus 60 requetes `_app`. Un `FAIL` bloque la
   promotion ; le noter dans `CYCLES.md` ("DS1 requis" / "DS1 en echec").
4. Verifier avant `promote.sh` que `beatbump-ekaii:staging` est bien revenu sur `NEW`
   (`docker image inspect -f '{{.Id}}' beatbump-ekaii:staging`), puis `sh promote.sh <sha de NEW>`.

## Cycle 43 (lane c43c) : healthcheck, smoke navigateur, planification

Livres en fichiers `.c43c` a cote des scripts vivants (le coordinateur les echange apres relecture) :
`../promote.sh.c43c`, `smoke.sh.c43c`, `../staging-compose.yml.c43c`, `../../e2e/run.sh.c43c` ; nouveau :
`../../e2e/harness-smoke.cjs`. Code : `healthcheck.go` + `main.go` + `Dockerfile` (commit `e3bfa83`, branche
`agents/c43c-ops-open`).

### Healthcheck du conteneur (B7-14)

L image `beatbump-ekaii` est `FROM scratch` (ffmpeg seulement : ni wget, ni curl, ni busybox, verifie par
`docker export | tar -t`). Le test est donc le binaire lui-meme : `/app/beat-server -healthcheck` fait un GET
`http://127.0.0.1:8080/api/v1/stats/library` (client 4 s) et sort 0 si 200 + JSON avec `version`, 1 sinon ;
decide dans `main()` AVANT `db.InitDB()` (aucune base, aucun worker, aucun listener). Le Dockerfile pose le label
`fr.ekaii.ytm.healthcheck=1`.
- `promote.sh` (seul chemin d ecriture du compose prod) ecrit le bloc dans le service `beatbump`, apres
  `restart: unless-stopped`, de facon idempotente, SEULEMENT si l image promue porte le label ; sans label (image
  plus ancienne, rollback), un bloc existant est RETIRE : un binaire sans le flag ignorerait l argument et
  demarrerait un second serveur toutes les 30 s.
  ```
  healthcheck:
    test: ["CMD", "/app/beat-server", "-healthcheck"]
    interval: 30s / timeout: 5s / retries: 3 / start_period: 20s
  ```
- apres `up -d` : attente de `healthy` (75 s max) ; `unhealthy` ou toujours `starting` = `FAIL healthcheck`,
  exit 3 et lignes ROLLBACK (les 3 derniers essais du journal docker sont affiches).
- `staging-compose.yml.c43c` porte le meme bloc (sans condition : le staging sert l image de la chaine).
  Verifier : `docker inspect -f '{{.State.Health.Status}}' ytm-beatbump-staging` = `healthy`. ATTENTION : avec
  une image staging construite AVANT le commit `e3bfa83`, le conteneur sera `unhealthy` (binaire sans le flag,
  voir ci-dessus) ; n echanger le compose staging qu avec une image qui porte le label.

### Smoke navigateur (B7-15)

`e2e/harness-smoke.cjs` (structure, fixtures et helpers de `harness-core.cjs`, budget 90 s, arret dur 120 s) :
`smoke_home_first_personal_row` (/home, premiere `[data-row]` peinte avec des cartes), `smoke_local_track_plays`
(`/listen?id=<fixtures.localLid>`, "Start Listening", source `/localf`, `currentTime` qui avance ; aucune
acquisition), `smoke_service_worker` (enregistrement actif de `/service-worker.js`), `smoke_version` (version
servie non vide et egale a `--expect=` / env `YTM_SMOKE_EXPECT` si donnee), `smoke_under_budget`. `report.json`
comme les autres harness (noms d etapes distincts de `perf_cold_home_requests` / `load_home` : `weekly.sh` ne le
prend pas pour un rapport coeur ou hors-ligne).
```
SMOKE_BROWSER=1 sh /srv/beatbump/agents/ops/smoke.sh https://music.ekaii.fr [sha attendu]   # 12e controle
./run.sh https://staging-music.ekaii.fr "daft punk" harness-smoke.cjs                                 # direct
```
- `smoke.sh` : avec `SMOKE_BROWSER=1`, controle `smoke_browser` (+ `smoke_browser_duration` si > 90 s) joue via
  `e2e/run.sh` sous `timeout 240` ; si un conteneur `ytm-harness-*` tourne deja, ou si `run.sh` refuse (exit 2),
  ligne `SKIP smoke_browser ...` et PAS d echec (un seul navigateur a la fois). Le budget HTTP de 90 s ne compte
  pas le navigateur (`SMOKE ... en N s (navigateur M s)`). `SMOKE_ALERT=1` : un echec ajoute un bloc (lignes
  FAIL) a `program/ALERT.md`, meme forme que `weekly.sh`.
- `run.sh.c43c` : transmet `YTM_SMOKE_EXPECT` au conteneur (run.sh ne passe aucun argument au harness) et, avec
  `YTM_RUN_SKIP_BUILD_WAIT=1`, saute l attente du verrou de build (`finish-cycle.sh` tient
  `/tmp/beatbump-build.lock` autour de `promote.sh` : sans cela le smoke attendrait 900 s "le build"). Les gardes
  un-seul-harness et charge restent.
- `promote.sh.c43c` : appelle `smoke.sh` avec `SMOKE_BROWSER=1` (`PROMOTE_SMOKE_BROWSER=0` pour s en passer) et
  `YTM_RUN_SKIP_BUILD_WAIT=1` ; un smoke en echec (HTTP ou navigateur) = `exit 3` (promu mais pas sain) + bloc
  `## <date> UTC (promote.sh)` dans `program/ALERT.md` avec les lignes FAIL / SKIP / SMOKE. Non joue contre la prod
  ni le staging au cycle 43 (chaine en cours) : premiere preuve = prochaine promotion, ou un run direct.

### Planification (B7-16, decision 19 de `program/DECISIONS-PAUL.md`)

Rien n est installe : `crontab -l` du compte `docker-host` ne contient aucune ligne ytm tant que Camille n a pas
repondu. Les deux lignes, pour `crontab -e` (la box est en UTC), sont celles de `cron.weekly.example` (mis a
jour au cycle 53, lane c53a, B9-15) :

- hebdomadaire, lundi 06:00 UTC (decision 19) : `ops/monday.sh` = attente d une box libre (pas de
  `ytm-harness-*`, pas de `finish-cycle.sh`, verrou de build libre ; au plus 30 min), harness prod
  `HARNESS_TIER=full` coeur puis hors-ligne via `e2e/run.sh` (qui garde ses refus), `weekly.sh` avec
  `WEEKLY_DB_RO=1`, `smoke.sh` HTTP avec `SMOKE_ALERT=1` et le dernier `PROD = <sha>` de `CYCLES.md` en version
  attendue. Journal complet `program/logs/monday-<date>.log` (10 gardes), resume seul sur stdout ; code de
  sortie = le pire des trois (`MONDAY_SKIP_HARNESS=1` pour un test rapide sans navigateur) :
  ```
  0 6 * * 1 /bin/sh /srv/beatbump/agents/ops/monday.sh >> /srv/beatbump/agents/ops/monday-cron.log 2>&1  # music.ekaii.fr lundi (cycle 53)
  ```
- smoke quotidien (06:30 UTC, HTTP + navigateur, bloc `ALERT.md` en cas d echec ; saute le navigateur si un
  harness tourne) :
  ```
  30 6 * * * SMOKE_BROWSER=1 SMOKE_ALERT=1 /bin/sh /srv/beatbump/agents/ops/smoke.sh https://music.ekaii.fr >> /srv/beatbump/agents/ops/smoke-cron.log 2>&1  # music.ekaii.fr smoke (cycle 43)
  ```
Lecture : `tail -3 program/WEEKLY.md`, `tail -5 ops/monday-cron.log`, `tail -5 ops/smoke-cron.log`, `ls -l
program/ALERT.md`. Verification attendue (brainstorm-v7 puis v9) : `crontab -l | grep -c 'monday.sh\|smoke.sh'`
= 2 ; un smoke force en echec (par exemple un sha attendu faux en 2e argument) ajoute un bloc a `ALERT.md`.

## Cycle 44 (lane c44c) : library-lint et mesure du trou entre morceaux

### library-lint (B7-9)

`python3 /srv/beatbump/agents/ops/library-lint.py` (stdlib seule, lecture seule, `--host music.ekaii.fr` pour la prod ; SNI et `Host` = `--host`, adresse `--ip` 127.0.0.1 = Traefik local) interroge l API publique (`stats/library`, `local/mixes`, `local/albums`, `local/songs?genre=`, `local/genres`, `local/artists`, HEAD `/cover`) et ecrit `program/LIBRARY-LINT.md` : 4 sections chiffrees, 30 exemples avec ids chacune, en moins de 10 s (199 requetes, 6,9 s le 02/10 sur staging : 148 albums sans attribut `year` (216 sans annee exploitable d apres les decennies de `local/mixes`), 0 sans pochette, 37 genres a un seul album sur 109 noms exposes, 57 groupes d artistes quasi-doublons).
Limites de l API publique, dites dans le rapport : l annee n est pas exposee par album (les docs sans attribut `year` sont en queue des deux tris `year:asc` / `year:desc`, leur intersection les identifie) ; les valeurs brutes des tags genre (`;`, `/`, `_`) sont deja normalisees cote serveur et la facette est bornee aux 100 premieres valeurs alphabetiques ; `matchNorm` de `local_match.go` est reimplemente en Python (casse, accents, `feat.`, `&`, ponctuation).

### Mesure du trou entre deux morceaux (B7-18)

```
cd /srv/beatbump/e2e && timeout 600 ./run.sh https://staging-music.ekaii.fr "daft punk" probe-gap.cjs
```
A lancer quand AUCUN harness ne tourne (`run.sh` refuse sinon, exit 2 ; un seul navigateur sur la box). `probe-gap.cjs` part de l album de fixture (`localAlbumId`, "Tout lire" = `[data-testid="release-play"]`), la file continue avec les pistes liees de la bibliotheque, et mesure sur 10 enchainements le trou `ended` (piste n) -> `playing` (piste n+1) avec `performance.now()` sur l element media (hook `play()`, `window.__ytmMedia`). Deux passes : la 1re a froid (contexte neuf), puis les pistes jouees sont mises en cache par le SW (`cache-audio`, cache `ytm-offline-audio`) et la 2e rejoue la meme file ; chaque enchainement est classe `cache` / `reseau` d apres l etat reel du cache a l arrivee. Chaque piste est avancee a `duree - 8 s` (env `GAP_TAIL`, `GAP_TRANSITIONS`, `GAP_WAIT`) pour tenir dans 10 min ; le prefetch de la suivante est programme au debut de la piste, pas court-circuite. Sortie : `GAP non cache` / `GAP cache SW` (n, mediane, p90, min, max) sur stdout, `e2e/out/probe-gap.json` (transitions detaillees, `verdict`). Decision (brainstorm-v7 B7-18) : p90 local en cache < 300 ms = ne rien faire. Au 02/10 : ecrite et `node --check` seulement, pas encore jouee (chaine staging en cours).

## Cycle 48 (lane c48c) : garde svelte-check (B8-24)

Proposition `ops/finish-cycle.sh.c48c` (fichier complet, `sh -n` propre ; a copier sur `finish-cycle.sh` par la lane
qui tient le script) + `ops/svelte-check.baseline` (une ligne : `411`, le compte du cycle 48 ; HEAD de la lane c48c
mesure 411 apres svelte-kit sync, 409 sans). Avant la chaine staging (etape 0, juste apres l attente d un harness en cours),
`finish-cycle.sh` lance `npx svelte-kit sync` puis `npx svelte-check --threshold error` dans `agents/integration/app`
(lecture seule, 1 a 2 min), lit la ligne `svelte-check found N errors and W warnings in F files` et refuse (`exit 3`,
ligne `NOT GREEN (svelte-check au-dessus de la baseline)`, chaine non lancee, rien promu) quand `N` depasse la
baseline. Garde fermee : sortie sans cette ligne (node_modules absent, timeout 900 s) ou baseline illisible = refus.
La baseline ne descend que par commit (quand une lane reduit la dette, elle abaisse le fichier dans le meme commit).

- `FINISH_SKIP_SVELTE_CHECK=1` saute la garde (ligne `garde svelte-check : sautee`).
- `FINISH_PARSE_ONLY=1 sh finish-cycle.sh <cycle> <chaine>` joue aussi la garde et imprime
  `garde svelte-check maintenant : svelte-check N <= baseline B` (ou le refus qu un vrai run ferait).
- Test de la garde seule : `FINISH_SC_TEST=1 sh finish-cycle.sh` (exit 0 / 3, verdict sur stdout) ;
  `FINISH_SC_BASELINE=<fichier>` remplace la baseline (un fichier a `N-1` doit donner `exit 3`, l equivalent d un
  fichier force a +1 erreur) et `FINISH_SC_APP=<dossier app>` remplace `agents/integration/app` (test seulement).
- Verification faite le 02/10 par c48c (arbre `agents/c48c-dayone`, baseline de test 408) : voir le rapport de la lane.

## Harness paliers (cycle 47, lane c47a : B8-13, B8-14, B8-16, B8-17, B8-18)

Pourquoi : chaine 53, coeur 79 etapes en 643 s pour un budget de 480 s (689 s a la chaine 54), avec 7 etapes
neuves encore gatees. Trois leviers, aucune assertion changee ; fichiers vivants remplaces par `mv`, copies
`.bak-c47a` a cote (`e2e/harness-core.cjs`, `harness-offline.cjs`, `steps-c42..c47-*.cjs`, `run.sh`,
`ops/stage-cycle.sh`, `ops/finish-cycle.sh`).

### Deux paliers : `HARNESS_TIER=chain|full`

- `chain` (defaut ; `stage-cycle.sh` le passe explicitement) : les quatre etapes lentes et jamais regressees de
  `FULL_ONLY` (`harness-core.cjs`) ne jouent pas : `resume_take_over` (59 s ; `resume_remote` couvre l offre et
  "Continuer ici"), `buttons_readable` (44 a 99 s, audit visuel), `recent_by_day` (43 s, jamais regressee depuis le
  cycle 23), `french_program_screens` (32 s, doublon du test structurel vitest de c31a). Chaque nom reste dans le
  code ; une etape sautee imprime `SKIP <nom> - tier full only` et figure dans `report.json.skippedTier`.
- `full` : `finish-cycle.sh` le passe au harness prod apres la promotion (coeur et hors-ligne) : chaque etape est
  donc jouee a chaque promotion, sur prod. Budget total : 8 min en `chain`, 12 min en `full` (`report.budgetMs`).
- `run.sh` transmet `HARNESS_TIER` et `HARNESS_ONLY` au conteneur comme `YTM_SMOKE_EXPECT`. Une etape peut aussi
  declarer `opts.tier = "full"` (`step(page, name, fn, { tier: "full" })`).
- `HARNESS_ONLY=a,b` : ne joue que ces etapes (les etapes des modules tournent dans des contextes neufs ; une
  etape du coeur qui depend d une lecture en cours doit etre jouee avec `play_from_search` : `HARNESS_ONLY=home_loads,search_results,play_from_search,<etape>`).
  ```
  cd /srv/beatbump/e2e && HARNESS_ONLY=bienvenue_page timeout 600 ./run.sh https://staging-music.ekaii.fr "daft punk" harness-core.cjs 2>&1 | grep -E "^(PASS|FAIL|Report)"
  HARNESS_TIER=full timeout 1500 ./run.sh https://music.ekaii.fr "daft punk" harness-core.cjs 2>&1 | grep -E "^(PASS|FAIL|SKIP|Report)"
  ```

### Fenetre de calme apres `goto` : `gotoQuiet(page, url, opts)`

L enveloppe `browser.newContext` de `harness-core.cjs` attend jusqu a 4 s de `networkidle` apres CHAQUE `goto`,
et cette attente n aboutit jamais tant que la restauration au demarrage met un titre en cache (98 `goto` dans le
coeur, six etapes a exactement 4,1 s). `gotoQuiet` navigue en `domcontentloaded` puis attend le PREMIER de :
`networkidle` reel (tot sans audio), 1,5 s sans nouvelle requete (le flux audio ouvert ne compte pas), ou le
plafond de 4 s ; puis `load` s il n a pas encore eu lieu. Env : `HARNESS_GOTO_QUIET_MS` (1500),
`HARNESS_GOTO_CAP_MS` (4000). Utilisee sur les 36 `goto` les plus chauds de la page principale (21 etapes du
palier chaine + l aide `search()`), l enveloppe reste pour les 62 autres ; passee aux modules par `deps.gotoQuiet`.
Mesure dans `report.json` : `gotoCount`, `gotoWaitMs` (somme des fenetres), `gotoHow` (`networkidle` / `quiet` /
`cap`) et `firstSoundMs` (clic -> premier son de `play_from_search`, B8-3, seuil d alerte 3 s) ; la ligne
`Report budget:` les imprime (`gotoQuiet 36 x 1.6 s (idle 2/quiet 34/cap 0), firstSound=812 ms`).

### Etapes reactivees et etapes gatees "enable with chain 55"

Reactivees (B8-16, chacune jouee seule par c46b avant) : `mediasession_real_handlers` (C42, 21 s),
`ux_v12_open_fixes` (C43, 5 s), `artist_of_day_stable` (C44 coeur, 4 s), `pack_too_big` (C44 hors-ligne, 2 s),
`bienvenue_page` (C45 coeur, 2 s), `login_keeps_inflight_writes` (C45 stats, 43 s).
Gatees jusqu a ce que la chaine 55 construise `f257daa` sur le staging (fdcd7a4 aujourd hui) :
- `pack_refresh` (`steps-c44-offline.cjs` `C44_SKIP`) : depuis c47c (B8-11) le clic sur `pack-refresh` ouvre un
  apercu (`pack-refresh-preview`, `pack-refresh-row`, `__ytmPackRefresh.preview === true`, rien de desepingle) et
  `pack-refresh-confirm` l applique ; l etape gere les deux versions (apercu ou resultat direct) et confirme ;
- `pack_refresh_preview`, `data_saver_no_prefetch` (`steps-c47-core.cjs` `C47_SKIP`, greffe apres c45-stats).
Pour les activer (coordinateur, chaine 55) : vider `C44_SKIP` dans `steps-c44-offline.cjs` et `C47_SKIP` dans
`steps-c47-core.cjs`, puis `node --check` ; attendu : coeur +2 etapes, hors-ligne +1.

### Regles (brainstorm v8, 2.3)

1. Une etape neuve est jouee SEULE (`HARNESS_ONLY=<nom>`) avant d entrer dans une chaine.
2. Jamais `const URL` ni `const Symbol` dans un module (`deps.URL` est la chaine de base ; le constructeur est
   `globalThis.URL` ; chaines 47 a 50, L13-12).
3. Toute etape de plus de 20 s justifie son palier dans un commentaire (`chain` : elle protege un parcours qui a
   deja regresse ; sinon `full`).
4. Une etape neuve = un palier declare + un run seul + une etape fusionnee ou passee en `full` en face.

### Fusions (B8-15) : les trivialement sures sont faites par c52c (B9-21), le reste attend

Faites (cycle 52, voir "Cycle 52 (lane c52c)" plus bas) : `not_found_page` absorbe `error_page_stays`,
`artist_not_found`, `explore_unknown_category` ; `share_target` dans `share_target_smart` ; `perf_v3` + `perf_v4`
dans `perf_cold_home_requests` (nom garde, `weekly.sh:93`). Restantes, faisables sans perdre une assertion mais
pas triviales (ordre des lectures, etats partages de la page principale) : `resume_exact` + `shortcut_resume`
(meme lecture > 6 s, meme persistance 5,5 s, un seul rechargement puis `/home?resume=1`) ; `queue_actions` +
`queue_reorder_next` (la premiere vide la file a 1 ligne, la seconde en veut 3, et seule la seconde a le rejeu
`FLAKY_KNOWN`) ; la partie MediaSession de `night_lockscreen` dans `mediasession_real_handlers` (deux modules).
A faire dans une lane harness dediee avec 3 runs coeur avant / apres ; les `detail` des etapes fusionnees gardent
chaque assertion (chaine "a ; b ; c").

### Mesure (02/10, staging fdcd7a4, charge 1 min 25 a 30)

Avant (04:08, chaine 54, 79 etapes, 7 gatees) : 689 s, somme des etapes 680 s (chaine 53 : 643 s). Apres, palier
`chain` sur fdcd7a4, trois runs coeur de suite (`/tmp/ytm-c47a-core-{1,2,3}.log`, rapports `e2e/out/20261002-050004`,
`-051125`, `-052551`) :
- run 1 : 79 PASS / 1 FAIL en 492 s (charge 35) ; l echec `stats_time_views` etait une dependance cachee :
  `recent_by_day` (passe en `full`) connectait la page principale en `harness-days` avec une ecoute comptee, sans
  quoi `[stats-streak]` n existe pas (meme echec sur prod a la chaine 54, ou les ecoutes harness sont ignorees) ;
  l etape pose maintenant son propre etat (login `harness-days` idempotent + une ecoute semee ; sur prod, regle
  "ecoute ignoree" = etat vide asserte, comme `share_year`) ;
- run 2 : 80 PASS / 0 FAIL en 508 s (charge 35 a 37 ; 16 `goto` de plus convertis, `firstSound` 10 s = box chargee) ;
- run 3 : **80 PASS / 0 FAIL en 446 s** (charge 41 a 50) apres `waitQuiet` dans `album_page` (22 s -> 1,6 s) ;
  `gotoQuiet` 56 appels x 1,12 s (idle 46 / quiet 10 / cap 0). Les 75 etapes communes passent de 472 s a 417 s
  (run 2) ; les 5 etapes reactivees du coeur en ajoutent 81 s ; les 4 etapes `full` en retirent 140 a 210 s.
- hors-ligne (`chain`) : 19 PASS / 0 FAIL en 126 s (`pack_too_big` reactivee, `pack_refresh` gatee).
- `probe-gap.cjs` jouee une fois (B7-18) : mesure non concluante (9 enchainements sur 10 sans `ended`), voir
  `program/GAP-MEASURE.md`.
Palier `full` : non joue par c47a (un seul navigateur, chaines prioritaires) ; premiere preuve = harness prod de
la chaine 55 (`finish-cycle.sh`), attendu 84 etapes coeur (80 + 4) en 600 a 650 s sous 720 s.

## Cycle 50 (lane c50a) : verdict de cache dans le journal, log-latency.py filtre (PF5-8) et caches PF5-2/3/5/6/7

### Journal d acces avec le verdict de cache (PF5-8 a)

Depuis c50a le logger Echo (`logger.go`, `accessLogConfig`, branche dans `main.go`) ecrit deux champs de plus
par ligne : `"cache"` (en-tete de reponse `X-Ytm-Cache` : HIT / STALE / MISS / BYPASS sur les routes cachees et
sur le memo 404 de `/cover`) et `"mix_cache"` (`X-Ytm-Mix-Cache` sur `me/mix`). Les autres champs gardent
leurs noms, leur ordre et leurs types : `weekly.sh` (bloc PYACCESS) et `log-latency.py` lisent la meme ligne.
Un journal d une image d avant c50a n a pas ces champs (colonnes `-`).

### log-latency.py : exclusions par defaut et colonnes cache (PF5-8 d)

```
docker logs --since 168h ytm-beatbump 2>&1 | python3 /srv/beatbump/e2e/perf-audit/log-latency.py
```
Par defaut le script exclut (decompte par classe sur stderr) : le healthcheck du conteneur (`127.0.0.1` / `::1`
avec l UA `Go-http-client`, `beat-server -healthcheck` toutes les 30 s, `healthcheck.go`), Uptime-Kuma, et le
harness (HeadlessChrome de Playwright, `ytm-harness-*`, `ytm-smoke`, `ytm-perf`, `perf*-audit`, les UA fixtures
`Mozilla/5.0 (Macintosh) Chrome/128` et `Mozilla/5.0 (X11; Linux x86_64) Chrome/126` de `harness-core.cjs`, l UA
iPhone de `ux-audit/shots.cjs`), plus curl et python (sondes). `--all` garde tout (comportement d avant c50a),
`--bots` ne garde QUE ces classes (mesurer le harness lui-meme). Les robots de carte OG (WhatsApp, Twitterbot,
facebookexternalhit) restent dans la mesure : c est du trafic reel. Deux colonnes de plus : `H/S/M`
(HIT/STALE/MISS) et `hit%` ((HIT+STALE)/(HIT+STALE+MISS)). Le script d avant est garde en
`log-latency.py.bak-c50a` (ni l un ni l autre n est dans git).
Limite : l UA iPhone fixture est la chaine exacte d un Safari iOS 17.5 ; un vrai iPhone sur cette version
exacte serait exclu avec elle.
Non fait : PF5-8 (b) suffixer les UA Playwright du harness (`harness-core.cjs`, `harness-offline.cjs`,
`harness-smoke.cjs`, `ux-audit/shots.cjs`), l exclusion regex couvre deja HeadlessChrome ; PF5-8 (c) copier le
journal de l ancien conteneur dans `e2e/perf-audit/out/<ts>-prod-access.jsonl` avant le `rm` de `promote.sh`
(a faire dans une lane ops, `promote.sh` n etait pas dans le perimetre c50a).

### Reglages de cache poses par c50a (rappel, verification apres promotion)

- `home.json` : 2 min + 24 h STALE, chauffe au demarrage (`api.WarmHome`) ; `local/mixes` : 5 min + 24 h,
  chauffe (`api.WarmLocalMixes`) ; `search.json` et `next.json` : 10 min + 1 h STALE (cle = requete complete
  triee, une continuation reste sa propre entree). Reglages dans `backend/api/rescache_routes.go`.
- `/cover` : un 404 (lid sans pochette) est memorise 1 h par lid dans le proxy Go (LRU 4 096), repondu avec
  `X-Ytm-Cache: HIT` sans appel au bridge ; un 200 pour le lid l oublie (`api.InvalidateCoverMiss` aussi).
- `PLAYER_TIMEOUT_SECONDS` : defaut 20 s (etait 90), l env est toujours honoree.
- Verification : dans le journal, `log-latency.py` doit montrer `hit%` > 0 sur `home.json`, `search.json`,
  `next.json`, `/api/v1/local/*` ; `/cover` 404 en HIT des le 2e client ; aucun `player.json` 200 au-dela de
  20 s.

### Etapes gatees : les voir dans report.json (c51b, hygiene du harness)

Le `report.json` de chaque run (`e2e/out/<ts>/report.json`, ecrit par `harness-core.cjs` et par
`harness-offline.cjs`) porte un tableau `gated` : les etapes que les modules `steps-c*.cjs` ont sautees
pendant CE run, telles qu elles etaient au moment du run (Set exporte `C<N>_SKIP` du module, plus env
`C<N>_SKIP="a,b"`, plus `C<N>_STEPS_ENABLED=0` qui gate tout le module). Chaque entree vaut
`{ module, step, source }` avec `source` = `set` (gatee dans le fichier), `env` (ajoutee par l environnement
du run) ou `require failed: ...` (module illisible, `step: "*"`). La ligne `Report gated: ...` du journal
repete la liste (`none` si rien). Lecture rapide : `jq '.gated' e2e/out/<ts>/report.json`. Les anciens Sets
`C18_SKIP`..`C41_SKIP` internes a `harness-core.cjs` sont vides (cycles fusionnes) et ne sont pas listes.

Regle : une etape neuve tourne gatee (nom dans le `C<N>_SKIP` de son module) pendant UNE chaine, puis est
activee (retiree du Set) a la chaine suivante une fois qu elle a passe seule. `gated` doit donc revenir a `[]`
au plus tard une chaine apres l ajout d une etape ; une entree qui persiste est une etape oubliee.

Aussi pose par c51b (statique, `node --check` seulement, joue par la prochaine chaine) :
- `home_stale_path` (`steps-c38-core.cjs`) : seuil de l appel cache-busted `home.json` = 2 000 ms sur le tier
  `chain` (staging), 3 500 ms sur le tier `full` (prod juste apres une promotion : 2 533 ms vu le 02/10) ; le
  detail imprime le tier et les ms.
- `harness-offline.cjs` (`pinned before=` du free-up) : lecteur `list-audio` reecrit sur le modele de `swList`
  (ecoute `navigator.serviceWorker`, port en secours, 5 s) ; il lisait toujours `-2` sur le port seul. Idem
  dans `dx-probe-pack-cancel-c43d.cjs` et `dx-probe-pack-cancel2-c43d.cjs`. Sauvegardes `*.bak-c51b`.

## Cycle 52 (lane c52c) : en-tete harness partout, fusions B8-15, pack_refresh_preview en full, journal d acces

Fichiers vivants remplaces par `mv`, copies `*.bak-c52c` a cote (chaque `.cjs` de `e2e/` touche, `steps-*.cjs`,
`harness-core.cjs`, `harness-offline.cjs`, `ops/stage-cycle.sh`, `agents/promote.sh`, ce README).

### `X-Ytm-Harness: 1` sur TOUS les contextes navigateur (B9-13)

Pourquoi : `harnessRequest` (`api/me_stats.go:34-43`, meme regle dans `client_log.go`) ne reconnait que l UA
`HeadlessChrome` ou l en-tete `X-Ytm-Harness: 1` ; tout contexte Playwright a UA personnalisee (iPhone de
`steps-c48-dayone.cjs`, `shots-c50.cjs`, `ux-audit/shots.cjs`) ecrivait donc des ecoutes en prod (17 profils
"actifs" = Gangnam Style, brainstorm v9 section 0). Staging garde `YTM_STATS_INCLUDE_HARNESS=1`.
- `harness-core.cjs` : `HARNESS_HEADERS` + `newHarnessContext(browser, opts)` (exportes), l enveloppe existante de
  `browser.newContext` fusionne aussi l en-tete (un module qui appellerait `browser.newContext` directement est
  couvert a l execution), chaque appel direct reecrit vers l aide, l aide passee aux modules par
  `deps.newHarnessContext`. Idem `harness-offline.cjs`.
- `steps-*.cjs` (14 modules) : une ligne de compatibilite en tete de `run(deps)` :
  `const newCtx = deps.newHarnessContext || ((b, o) => b.newContext({ ...o, extraHTTPHeaders: { ..., "X-Ytm-Harness": "1" } }))`
  puis `newCtx(browser, opts)` a la place de `browser.newContext(opts)`. Un `harness-core.cjs` ancien deja en
  memoire (chaine en cours) qui charge un module neuf ne passe pas l aide : le repli pose l en-tete quand meme.
- Scripts autonomes (`probe-*.cjs`, `shot*.cjs`, `shots-c50.cjs`, `ux-audit/*.cjs`, `access-audit/*.cjs`,
  `perf-audit/harness-perf.cjs`, `harness-smoke.cjs`, `harness.cjs`, `c46b-lib.cjs`, `dx-probe-*.cjs`,
  `probe-deploy-survives.cjs` via `launchPersistentContext`) : `extraHTTPHeaders: { "X-Ytm-Harness": "1" }` en
  ligne dans chaque appel.
- Auto-controle statique, sans navigateur : `node e2e/check-harness-headers.cjs` parcourt chaque `.cjs` de `e2e/`
  (hors `node_modules`, `out`, `profiles`), extrait le texte de chaque appel `newContext(` /
  `launchPersistentContext(` et exige l en-tete en ligne, `HARNESS_HEADERS` ou `newHarnessContext(` ; exception
  volontaire = commentaire `// no-harness-header: <raison>` sur la ligne. Sortie 1 avec la liste `fichier:ligne`,
  sinon le nombre d appels verifies. `stage-cycle.sh` le lance avant le harness coeur et s arrete s il est rouge.
  Verifie rouge sur une copie des fichiers d avant c52c (toutes les lignes listees), vert apres.
- Preuve attendue (chaine 61, harness prod `full`) : `select count(*) from play_events where played_at > <debut>`
  (lecture `mode=ro`) = 0.

### Fusions B8-15 faites (B9-21), noms `perf_cold_home_requests` et `load_home` conserves

Seules les fusions trivialement sures (meme sequence de la page principale, chaque assertion gardee, `detail`
"a ; b ; c") :
- `not_found_page` = `not_found_page` + `error_page_stays` + `artist_not_found` + `explore_unknown_category`
  (quatre etapes consecutives qui s enchainaient deja sur la page principale) ; `not_found_status` (fetch
  seulement) reste une etape, jouee juste apres.
- `share_target_smart` absorbe `share_target` (manifest `share_target.action`, `GET /share-target` 200, lien
  youtu.be partage -> `/listen` sans lecture automatique, etat "non reconnu" avec `share-home`).
- `perf_cold_home_requests` absorbe `perf_v3` (search.json < 300 Ko, `/cover` 404 cacheable, home.json HIT/STALE,
  un seul `me/stats/recent` par chargement de `/home`) et `perf_v4` (`whoami` compte sur l accueil a froid,
  `local/artists` < 60 ms, page never-played). Une substitution : l assertion "un seul `me/stats/recent`" est
  posee sur le chargement a froid du contexte neuf (12 rapports de suite a `me/stats/recent=1`) au lieu d un
  second `/home` chaud de la page principale (navigation en moins a la position c25). Le `detail` commence
  toujours par le resume a froid que `weekly.sh:110` imprime ("accueil a froid").
Bilan : 89 -> 83 etapes coeur ; gain surtout en captures d ecran et navigations (une dizaine de secondes), pas
les -55 s du brainstorm (les deux fusions de lectures, `resume_*` et `queue_*`, restent a faire, section
"Harness paliers").

### `pack_refresh_preview` en palier `full` (B9-22 du brainstorm, item 3 de la lane)

`steps-c47-core.cjs` : `{ budgetMs: 600000, tier: "full" }` (64 a 111 s, jamais regressee, `pack_refresh` du
hors-ligne couvre le rafraichissement). Attendu : chain `skippedTier` contient `pack_refresh_preview`, full prod
la joue. Non fait (non demande a la lane) : les attentes fixes de 10 s de `login_keeps_inflight_writes`.

### Journal d acces copie a chaque promotion (B9-19 / B9-22)

`promote.sh`, juste avant `docker compose up -d --no-deps beatbump` : `timeout 60 docker logs ytm-beatbump >
agents/program/logs/access-<TS>-<sha ancienne image>.log 2>&1` (dossier cree, 10 fichiers gardes, echec non
bloquant avec un message ATTENTION). L audit perf relit l historique :
`cat /srv/beatbump/agents/program/logs/access-*.log | python3 e2e/perf-audit/log-latency.py`
(lignes JSON du logger Echo, memes champs que `docker logs`). Preuve attendue : la promotion de la chaine 61
laisse un `access-*.log` > 0 octet.

## Cycle 59 (lane c59c, 04/10) : decisions 15 (jeton), 17, 19, 20, 22 appliquees (mandat de Camille : defaut recommande)

### Secrets hors depot : `beatbump.env` et `beatbump-staging.env` (decisions 15 et 17)

- `/srv/beatbump/beatbump.env` (prod) et `/srv/beatbump/beatbump-staging.env` (staging), mode 600,
  proprietaire `docker-host`, hors de tout depot. Contenu (noms seulement) : `COMPANION_SECRET_KEY` (valeur deplacee
  depuis `staging-compose.yml`, identique a celle du compose prod, non tournee : le companion l utilise et sa rotation
  est un composant hors pipeline, decision 17), `YTM_ADMIN_TOKEN` (32 octets aleatoires `openssl rand -hex 32`, le meme
  dans les deux fichiers), `YTM_REPORT_EMAIL` ABSENT (commentaire dans le fichier) : Camille doit donner l adresse ;
  sans elle `/about` garde le bouton "Copier le diagnostic". Le jeton n est pas encore dans le coffre (`vault`) :
  depot par Camille (Touch ID), copie de reference = le fichier 600.
- `staging-compose.yml` : la ligne `COMPANION_SECRET_KEY:` en clair est remplacee par
  `env_file: [/srv/beatbump/beatbump-staging.env]` (sauvegarde `staging-compose.yml.bak-c59c`) ;
  `docker compose --env-file /srv/beatbump/.env -f agents/staging-compose.yml -p ytm-staging config -q` valide,
  les deux variables sont presentes dans la config rendue. Le conteneur staging en marche n a PAS ete recree (des
  chaines tournaient) : effectif au prochain `up -d` de `stage-cycle.sh`.
- `promote.sh` (sauvegarde `promote.sh.bak-c59c`) : nouveau bloc python idempotent juste avant `compose prod valide`,
  meme patron que le bloc healthcheck : si `/srv/beatbump/beatbump.env` existe, est en mode 600 et porte
  `COMPANION_SECRET_KEY=`, il ajoute `env_file: - /srv/beatbump/beatbump.env` au service `beatbump` (avant
  `environment:`) et retire la ligne `COMPANION_SECRET_KEY:` en clair ; sinon le compose prod est laisse tel quel
  avec un message. Prouve deux fois sur une copie du compose prod (ajout puis "deja present", `config -q` OK).
  Le compose prod reel `/srv/beatbump/docker-compose.yml` n a PAS ete modifie et la prod n a pas redemarre :
  la prochaine promotion applique le changement, puis `GET /api/v1/client-log` repond avec `Authorization: Bearer`
  (le jeton est lu depuis le fichier : `grep '^YTM_ADMIN_TOKEN=' /srv/beatbump/beatbump.env | sh ops/weekly.sh -`
  ou `monday.sh` a adapter : il appelle encore `weekly.sh` sans jeton).

### Planification installee (decision 19)

Les deux lignes de `cron.weekly.example` sont dans le crontab de `docker-host` depuis le 04/10 21:26 UTC (sauvegarde
du crontab precedent : `ops/crontab.bak-c59c`, 134 lignes, toutes conservees ; 137 apres) : `monday.sh` lundi 06:00 UTC,
`smoke.sh` 06:30 UTC avec `SMOKE_BROWSER=1 SMOKE_ALERT=1`. `crontab -l | grep -c 'monday.sh\|smoke.sh'` = 2. Pas de
ligne PATH : `docker`, `node`, `curl`, `flock`, `timeout`, `python3` sont dans `/usr/bin` (PATH par defaut du cron).
Premiere execution attendue : smoke le 05/10 06:30 UTC, monday.sh le 06/10 06:00 UTC ; lire `ops/smoke-cron.log`,
`ops/monday-cron.log`, `program/WEEKLY.md`, `program/ALERT.md`. Le smoke force en echec (preuve du bloc ALERT.md)
n a pas ete rejoue ici (deja prouve au cycle 43).

### Purge des ecoutes du harness (decision 20)

04/10 21:26 UTC, en root via `docker run --rm python:3.12-alpine` (base `root:root 644`), script
`c59c-step3-purge.py` (stdlib sqlite3) : sauvegarde en ligne par l API `backup` vers
`image-backups/beatbump-db-before-purge-20261004-212617.sqlite` (6 316 032 octets, root 600, verifiee : memes comptes),
puis compte = 134 lignes / 62 profils (exactement l attendu de la decision ; tolerance 20 % sinon arret), `DELETE`
en une transaction avec `assert deleted == counted` (134), recompte = 0 ; `play_events` 975 -> 841 (depuis le
30/09 21:00 : 242 -> 108, les 108 restantes = humains, dont les ecoutes des 02-04/10). Aucun redemarrage, conteneur
prod inchange (healthy). Retour arriere : copier la sauvegarde sur `beatbump-db/beatbump.db` apres
`docker compose stop beatbump` (puis `up -d`).

### Ancien arbre `beatbump-src` remis au propre (decision 22)

`image-backups/beatbump-src-20261004-212604.tar.gz` (60 887 306 octets, `gzip -t` OK, 3 054 entrees) puis
`git checkout -- .` et suppression de `app/src/app.html.bak-umami-20260720` : `git status --short | wc -l` 21 -> 0,
HEAD `94ad454` (branche `ekaii-fullapp`) inchange.
